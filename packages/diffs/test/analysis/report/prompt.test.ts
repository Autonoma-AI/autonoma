import type { AnalysisVerdict } from "@autonoma/types";
import { describe, expect, it } from "vitest";
import { REPORTER_SYSTEM_PROMPT, buildReporterPrompt } from "../../../src/analysis/report/prompt";
import type {
    ReporterBranchTest,
    ReporterExistingIssue,
    ReporterFinding,
    ReporterInput,
} from "../../../src/analysis/report/types";
import { Codebase } from "../../../src/codebase";

function finding(slug: string, category: AnalysisVerdict, extra: Partial<ReporterFinding> = {}): ReporterFinding {
    return { slug, category, headline: `${slug} headline`, selfHealed: false, screenshots: [], ...extra };
}

function branchTest(
    slug: string,
    category: AnalysisVerdict,
    extra: Partial<ReporterBranchTest> = {},
): ReporterBranchTest {
    return {
        slug,
        name: `${slug} test`,
        category,
        checkedThisRun: true,
        attributedToClientIssue: false,
        ...extra,
    };
}

function promptText(
    findings: ReporterFinding[],
    branchTests: ReporterBranchTest[] = findings.map((f) => branchTest(f.slug, f.category)),
    existingIssues: ReporterExistingIssue[] = [],
): string {
    const input: ReporterInput = {
        appSlug: "acme",
        target: { kind: "pull_request", prNumber: 42, prTitle: "Add coupon codes" },
        range: { baseSha: "aaaaaaa", headSha: "bbbbbbb" },
        findings,
        branchTests,
        existingIssues,
        priorReports: [],
        scenarioIndex: [],
        // The prompt never reads the repo - only the tools do - so an unused root is enough.
        codebase: new Codebase("/tmp/reporter-prompt-test"),
    };
    const [message] = buildReporterPrompt(input);
    const content = message?.content;
    return typeof content === "string" ? content : "";
}

/**
 * The constraint text IS the product here: what the Reporter is told is the only thing standing between a reader and
 * a report that describes the wrong commit, or one that reads as an all-clear over flows that never ran.
 */
describe("REPORTER_SYSTEM_PROMPT", () => {
    it("makes honesty a completeness obligation rather than a list of banned words", () => {
        // The old design handed the agent a verdict computed from counts and forbade it from softening the copy. It
        // authors the top line now, so a vocabulary ban would protect nothing - omission is the live failure.
        expect(REPORTER_SYSTEM_PROMPT).toContain("your account must add up to everything that happened");
        expect(REPORTER_SYSTEM_PROMPT).toContain("The way this goes wrong is never a lie - it is omission");
        expect(REPORTER_SYSTEM_PROMPT).not.toContain("you do not author it");
    });

    it("tells the agent it is describing the whole branch, and why a stale pass still counts", () => {
        // Phrased as "branch" rather than "pull request" because a main-branch run has no PR but accumulates
        // evidence across commits in exactly the same way.
        expect(REPORTER_SYSTEM_PROMPT).toContain("the WHOLE branch, not the latest commit");
        expect(REPORTER_SYSTEM_PROMPT).toContain("supersedes its own earlier pass");
    });

    it("asks for clustering by feature, and forbids the agent from judging its own flows", () => {
        // Splitting a feature by outcome is what hides that most of it works, which is the pessimism being fixed.
        expect(REPORTER_SYSTEM_PROMPT).toContain("Cluster by FEATURE, not by outcome");
        expect(REPORTER_SYSTEM_PROMPT).toContain("Do not state whether a flow counts as verified");
    });

    it("keeps the report from duplicating the itemization rendered above it", () => {
        expect(REPORTER_SYSTEM_PROMPT).toContain("DO NOT re-list the flows");
    });

    it("asks for the reason, and for the disclosure, when the run decided the change needed no test", () => {
        // A confident verdict is only worth anything if it says WHY, and says so when it declined to cover something
        // the reader can see - a reader who disagrees and asks for a test is a coverage lead.
        expect(REPORTER_SYSTEM_PROMPT).toContain("Give the SPECIFIC reason");
        expect(REPORTER_SYSTEM_PROMPT).toContain(
            "If the change touches something a user sees and we deliberately did not exercise it",
        );
        expect(REPORTER_SYSTEM_PROMPT).toContain("Never claim the change does not affect the UI");
        expect(REPORTER_SYSTEM_PROMPT).toContain("paraphrase it, never quote it");
    });
});

describe("buildReporterPrompt", () => {
    it("lists every branch test, marking which are carried from an earlier commit", () => {
        // The carried half is the part the agent has no other way to see; without it the report describes only the
        // newest commit, which is the defect this whole stage was reworked to fix.
        const text = promptText(
            [finding("checkout", "passed")],
            [
                branchTest("checkout", "passed"),
                branchTest("billing", "passed", { checkedThisRun: false, fromSha: "abc1234" }),
            ],
        );

        expect(text).toContain("# The branch's tests (2) - cluster ALL of these into flows, each exactly once");
        expect(text).toContain("Checked at this commit: 1. Carried from earlier commits: 1.");
        expect(text).toContain("- checkout [passed, this commit] checkout test");
        expect(text).toContain("- billing [passed, carried from abc1234] billing test");
    });

    it("separates this commit's findings from the branch list, and counts them", () => {
        const text = promptText([finding("checkout", "passed"), finding("cart", "engine_artifact")]);

        expect(text).toContain("# Findings at this commit (2: 1 confirmed the app, 1 did not complete)");
    });

    it("says plainly when a branch carries no tests at all", () => {
        const text = promptText([], []);

        expect(text).toContain("(none - no test has been investigated on this PR)");
        expect(text).toContain("(none - no test ran at this commit)");
    });

    it("shows a coverage finding's account of the fault, which is where an env gap's owner is readable", () => {
        const text = promptText([
            finding("invoices", "environment_failure", {
                whatHappened: "The preview served a 500 because the Firestore index the invoice query needs is absent.",
            }),
        ]);

        expect(text).toContain(
            "What happened: The preview served a 500 because the Firestore index the invoice query needs is absent.",
        );
    });
});
