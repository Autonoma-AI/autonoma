import type { AnalysisVerdict } from "@autonoma/types";
import { describe, expect, it } from "vitest";
import { computeCoverageViolations, hasCoverageViolations } from "../../../src/analysis/report/coverage";
import type { AuthoredIssueContent, RecordedIssueAction } from "../../../src/analysis/report/issue-actions";
import type { ReporterExistingIssue, ReporterFinding, ReporterIssueKind } from "../../../src/analysis/report/types";

function finding(slug: string, category: AnalysisVerdict): ReporterFinding {
    return { slug, category, headline: slug, selfHealed: false, screenshots: [] };
}

function openIssue(id: string, findingSlugs: string[], kind: ReporterIssueKind = "bug"): ReporterExistingIssue {
    return { id, title: id, kind, severity: "high", status: "open", actualBehavior: "x", findingSlugs };
}

function resolvedIssue(id: string, findingSlugs: string[]): ReporterExistingIssue {
    return { id, title: id, kind: "bug", severity: "high", status: "resolved", actualBehavior: "x", findingSlugs };
}

function content(findingSlugs: string[]): AuthoredIssueContent {
    return {
        title: "t",
        kind: "bug",
        severity: "high",
        expectedBehavior: undefined,
        actualBehavior: "a",
        narrativeMarkdown: "n",
        suspectedCause: undefined,
        primaryScreenshotAssetId: undefined,
        findingSlugs,
        // The designated reproduction must be one of the covered slugs; coverage only reads the list.
        primaryFindingSlug: findingSlugs[0] ?? "",
    };
}

function openAction(findingSlugs: string[]): RecordedIssueAction {
    return { kind: "open", content: content(findingSlugs) };
}

function carryAction(existingIssueId: string, findingSlugs: string[]): RecordedIssueAction {
    return { kind: "carry_forward", existingIssueId, content: content(findingSlugs) };
}

function resolveAction(existingIssueId: string, resolvingFindingSlug: string): RecordedIssueAction {
    return { kind: "resolve", existingIssueId, resolvingFindingSlug, note: "passes" };
}

describe("computeCoverageViolations - guarantee 1: every client_bug finding is covered", () => {
    it("flags a client_bug finding no issue covers", () => {
        const v = computeCoverageViolations([finding("checkout", "client_bug")], [], []);
        expect(v.uncoveredBugSlugs).toEqual(["checkout"]);
        expect(hasCoverageViolations(v)).toBe(true);
    });

    it("passes once an open or carry-forward action lists the slug", () => {
        const open = computeCoverageViolations([finding("checkout", "client_bug")], [], [openAction(["checkout"])]);
        expect(open.uncoveredBugSlugs).toEqual([]);

        const carried = computeCoverageViolations(
            [finding("checkout", "client_bug")],
            [openIssue("iss-1", ["checkout"])],
            [carryAction("iss-1", ["checkout"])],
        );
        expect(carried.uncoveredBugSlugs).toEqual([]);
    });

    it("does not require coverage for passing or coverage-plane findings", () => {
        const v = computeCoverageViolations([finding("login", "passed"), finding("flaky", "engine_artifact")], [], []);
        expect(hasCoverageViolations(v)).toBe(false);
    });
});

describe("computeCoverageViolations - guarantee 2: an open issue whose covering test passed is resolved", () => {
    it("flags an open issue whose covering test passed but was not resolved", () => {
        const v = computeCoverageViolations([finding("login", "passed")], [openIssue("iss-1", ["login"])], []);
        expect(v.unresolvedPassedIssueIds).toEqual(["iss-1"]);
    });

    it("passes once the issue is resolved", () => {
        const v = computeCoverageViolations(
            [finding("login", "passed")],
            [openIssue("iss-1", ["login"])],
            [resolveAction("iss-1", "login")],
        );
        expect(v.unresolvedPassedIssueIds).toEqual([]);
    });

    it("ignores already-resolved issues", () => {
        const v = computeCoverageViolations([finding("login", "passed")], [resolvedIssue("iss-1", ["login"])], []);
        expect(hasCoverageViolations(v)).toBe(false);
    });
});

describe("computeCoverageViolations - guarantee 3: an open issue whose covering test still failed is carried forward", () => {
    it("flags an open issue whose covering test still failed but was not carried forward", () => {
        const v = computeCoverageViolations(
            [finding("checkout", "client_bug")],
            [openIssue("iss-1", ["checkout"])],
            // The bug is covered by a NEW issue, so guarantee 1 holds and only guarantee 3 is exercised.
            [openAction(["checkout"])],
        );
        expect(v.uncarriedFailingIssueIds).toEqual(["iss-1"]);
        expect(v.uncoveredBugSlugs).toEqual([]);
    });

    it("passes once the issue is carried forward", () => {
        const v = computeCoverageViolations(
            [finding("checkout", "client_bug")],
            [openIssue("iss-1", ["checkout"])],
            [carryAction("iss-1", ["checkout"])],
        );
        expect(v.uncarriedFailingIssueIds).toEqual([]);
    });
});

describe("computeCoverageViolations - guarantee 3 recurrence is per issue kind, not bug-only", () => {
    it("requires carry-forward when an environment issue's covering test hit environment_failure again", () => {
        const v = computeCoverageViolations(
            [finding("invoices", "environment_failure")],
            [openIssue("iss-env", ["invoices"], "environment")],
            [],
        );
        // Carrying it forward is also what re-attributes the finding, which is how the PR comment keeps the gap on
        // the reader's side instead of reporting it as ours.
        expect(v.uncarriedFailingIssueIds).toEqual(["iss-env"]);
    });

    it("requires carry-forward when a scenario issue's covering test hit scenario_issue again", () => {
        const v = computeCoverageViolations(
            [finding("coupons", "scenario_issue")],
            [openIssue("iss-scn", ["coupons"], "scenario")],
            [],
        );
        expect(v.uncarriedFailingIssueIds).toEqual(["iss-scn"]);
    });

    it("passes once the recurring coverage issue is carried forward", () => {
        const v = computeCoverageViolations(
            [finding("invoices", "environment_failure")],
            [openIssue("iss-env", ["invoices"], "environment")],
            [carryAction("iss-env", ["invoices"])],
        );
        expect(hasCoverageViolations(v)).toBe(false);
    });

    it("leaves an environment issue alone when its covering test came back with a DIFFERENT fault", () => {
        const v = computeCoverageViolations(
            [finding("invoices", "engine_artifact")],
            [openIssue("iss-env", ["invoices"], "environment")],
            [],
        );
        // Our harness flaking is neither recurrence of their configuration gap nor proof it is gone.
        expect(hasCoverageViolations(v)).toBe(false);
    });

    it("does not treat a coverage recurrence as a bug issue's recurrence", () => {
        const v = computeCoverageViolations(
            [finding("checkout", "environment_failure")],
            [openIssue("iss-bug", ["checkout"])],
            [],
        );
        expect(hasCoverageViolations(v)).toBe(false);
    });
});

describe("computeCoverageViolations - a split covering set requires carry-forward, never resolve", () => {
    it("treats an issue with one still-failing and one passing covering test as carry-forward-required", () => {
        const v = computeCoverageViolations(
            [finding("checkout", "client_bug"), finding("cart", "passed")],
            [openIssue("iss-1", ["checkout", "cart"])],
            [openAction(["checkout"])],
        );
        expect(v.uncarriedFailingIssueIds).toEqual(["iss-1"]);
        expect(v.unresolvedPassedIssueIds).toEqual([]);
    });

    it("leaves an issue whose covering tests did not run this job untouched", () => {
        const v = computeCoverageViolations([finding("login", "passed")], [openIssue("iss-1", ["unrelated"])], []);
        expect(hasCoverageViolations(v)).toBe(false);
    });
});
