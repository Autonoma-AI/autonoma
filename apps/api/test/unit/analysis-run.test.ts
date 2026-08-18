import type { Finding } from "@autonoma/analysis";
import type { SuiteChange } from "@autonoma/test-suite";
import { describe, expect, it } from "vitest";
import { type LatestGeneration, buildAnalysisRunView } from "../../src/routes/branches/analysis-run";

function finding(overrides: Partial<Finding> & { slug: string }): Finding {
    const { slug, ...rest } = overrides;
    return {
        findingId: `finding-${slug}`,
        testCase: { id: `tc-${slug}`, name: slug, slug },
        selfHealed: false,
        classifications: [],
        ...rest,
    };
}

function judged(category: string, headline: string): Finding["current"] {
    return { generationId: "gen", category, headline };
}

function suiteChange(overrides: Partial<SuiteChange> & { slug: string; type: SuiteChange["type"] }): SuiteChange {
    const { slug, type } = overrides;
    const base = {
        testCaseId: `tc-${slug}`,
        testCaseName: slug,
        testCaseSlug: slug,
        testCaseFolderId: "folder",
    };
    if (type === "added") return { ...base, type, plan: `${slug} plan` };
    if (type === "removed") return { ...base, type, previousPlan: `${slug} previous plan` };
    return { ...base, type, plan: `${slug} plan`, previousPlan: `${slug} previous plan` };
}

describe("buildAnalysisRunView", () => {
    it("derives each row's state: running, judged, and contained", () => {
        const findings: Finding[] = [
            finding({ slug: "running", origin: "pre_existing" }),
            finding({ slug: "judged", origin: "pre_existing", current: judged("client_bug", "Checkout breaks") }),
            finding({
                slug: "contained",
                origin: "proposed",
                failure: { kind: "investigator_crashed", message: "died" },
            }),
        ];
        const startedAt = new Date("2026-01-01T10:00:00.000Z");
        const completedAt = new Date("2026-01-01T10:03:00.000Z");
        const generations = new Map<string, LatestGeneration>([
            ["tc-running", { status: "running", startedAt }],
            ["tc-judged", { status: "success", startedAt, completedAt }],
        ]);

        const view = buildAnalysisRunView(findings, generations, []);

        const running = view.findings.find((row) => row.testCase.slug === "running");
        expect(running?.verdict).toBeUndefined();
        expect(running?.contained).toBe(false);
        expect(running?.generationStatus).toBe("running");
        expect(running?.startedAt).toEqual(startedAt);
        expect(running?.completedAt).toBeUndefined();

        const judgedRow = view.findings.find((row) => row.testCase.slug === "judged");
        expect(judgedRow?.verdict).toEqual({ category: "client_bug", headline: "Checkout breaks" });
        expect(judgedRow?.generationStatus).toBe("success");
        expect(judgedRow?.completedAt).toEqual(completedAt);

        const contained = view.findings.find((row) => row.testCase.slug === "contained");
        expect(contained?.contained).toBe(true);
        expect(contained?.verdict).toBeUndefined();
        // No generation for a crashed investigation - the status is simply absent.
        expect(contained?.generationStatus).toBeUndefined();
        expect(contained?.startedAt).toBeUndefined();
    });

    it("summarizes the selection by origin", () => {
        const findings: Finding[] = [
            finding({ slug: "a", origin: "pre_existing" }),
            finding({ slug: "b", origin: "pre_existing" }),
            finding({ slug: "c", origin: "proposed" }),
        ];

        const view = buildAnalysisRunView(findings, new Map(), []);

        expect(view.selection).toEqual({ targetCount: 3, affectedCount: 2, proposedCount: 1 });
    });

    it("drops an unrecognized origin rather than counting it", () => {
        const findings: Finding[] = [finding({ slug: "legacy", origin: "something_old" })];

        const view = buildAnalysisRunView(findings, new Map(), []);

        expect(view.findings[0]?.origin).toBeUndefined();
        expect(view.selection).toEqual({ targetCount: 1, affectedCount: 0, proposedCount: 0 });
    });

    it("maps suite changes onto rows and lists finding-less removals as stubs", () => {
        const findings: Finding[] = [
            finding({ slug: "edited", origin: "pre_existing" }),
            finding({ slug: "created", origin: "proposed" }),
            finding({ slug: "culled", origin: "pre_existing", current: judged("invalid_test", "Premise gone") }),
        ];
        const changes: SuiteChange[] = [
            suiteChange({ slug: "edited", type: "updated" }),
            suiteChange({ slug: "created", type: "added" }),
            suiteChange({ slug: "culled", type: "removed" }),
            suiteChange({ slug: "pr-removed", type: "removed" }),
        ];

        const view = buildAnalysisRunView(findings, new Map(), changes);

        expect(view.findings.map((row) => [row.testCase.slug, row.change])).toEqual([
            ["edited", "edited"],
            ["created", "created"],
            ["culled", "removed"],
        ]);
        // The judged removal stays a finding row; only the finding-less one becomes a stub.
        expect(view.removedTests).toEqual([
            {
                testCase: { id: "tc-pr-removed", name: "pr-removed", slug: "pr-removed" },
                previousPlan: "pr-removed previous plan",
            },
        ]);
    });
});
