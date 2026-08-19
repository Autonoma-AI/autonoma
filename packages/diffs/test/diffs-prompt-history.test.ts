import { describe, expect, it } from "vitest";
import { buildDiffsUserPrompt, type DiffsPromptInput } from "../src/agents/diffs/diffs-prompt";
import type { BranchHistory } from "../src/diffs-agent";
import { FlowIndex } from "../src/flow-index";

function baseInput(branchHistory?: BranchHistory): DiffsPromptInput {
    return {
        analysis: { affectedFiles: ["src/app.ts"], summary: "changed the app" },
        range: { baseSha: "aaaa111", headSha: "bbbb222" },
        flowIndex: new FlowIndex([]),
        merges: [],
        preClassifiedConflicts: [],
        scenarioRecipes: [],
        branchHistory,
    };
}

const EMPTY_HISTORY: BranchHistory = { removedTests: [], priorReports: [], openIssues: [] };

describe("buildDiffsUserPrompt branch history", () => {
    it("is byte-identical with no history and with an all-empty history slice", () => {
        // The brand-new-branch parity guarantee: an empty slice adds nothing a stateless run would not have.
        const withoutField = buildDiffsUserPrompt(baseInput());
        const withEmpty = buildDiffsUserPrompt(baseInput(EMPTY_HISTORY));
        expect(withoutField).toBe(withEmpty);
        expect(withoutField).not.toContain("Branch history");
    });

    it("shows a removed invalid test with its reason and a do-not-recreate instruction", () => {
        const prompt = buildDiffsUserPrompt(
            baseInput({
                removedTests: [
                    { slug: "gone-feature", name: "Gone Feature", reason: "the feature was deleted" },
                    { slug: "no-note", name: "No Note" },
                ],
                priorReports: [],
                openIssues: [],
            }),
        );
        expect(prompt).toContain("Gone Feature");
        expect(prompt).toContain("gone-feature");
        expect(prompt).toContain("the feature was deleted");
        expect(prompt).toContain("do NOT re-create");
        // A removed test with no recorded reason renders as bare name/slug, never a dangling ": " sentinel.
        expect(prompt).toContain("**No Note** (`no-note`)");
        expect(prompt).not.toContain("(`no-note`):");
    });

    it("frames open issues as known areas to weigh, never as verdicts to reproduce", () => {
        const prompt = buildDiffsUserPrompt(
            baseInput({
                removedTests: [],
                priorReports: [],
                openIssues: [
                    {
                        title: "Checkout total wrong",
                        actualBehavior: "totals are off by one",
                        coveredSlugs: ["checkout"],
                    },
                ],
            }),
        );
        expect(prompt).toContain("Branch history");
        expect(prompt).toContain("Checkout total wrong");
        expect(prompt).toContain("NOT verdicts to reproduce");
        expect(prompt).toContain("do NOT need to reproduce");
    });

    it("truncates an overlong prior report to the shared bound", () => {
        const longReport = "x".repeat(5_000);
        const prompt = buildDiffsUserPrompt(
            baseInput({
                removedTests: [],
                priorReports: [{ snapshotId: "snap-1", report: longReport }],
                openIssues: [],
            }),
        );
        expect(prompt).toContain("...[truncated]");
        expect(prompt).not.toContain("x".repeat(5_000));
    });
});
