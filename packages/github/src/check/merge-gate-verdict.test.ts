import type { AnalysisVerdictSummary } from "@autonoma/types";
import { describe, expect, it } from "vitest";
import { buildMergeGateCheckResult, MERGE_GATE_SKIP_COMMAND, parseSkipCommand } from "./merge-gate-verdict";

function verdict(summary: Partial<AnalysisVerdictSummary> & Pick<AnalysisVerdictSummary, "state">) {
    return {
        state: summary.state,
        bugCount: summary.bugCount ?? 0,
        coverageGapCount: summary.coverageGapCount ?? 0,
        investigatedCount: summary.investigatedCount ?? 0,
    };
}

describe("buildMergeGateCheckResult", () => {
    it("maps a bug verdict to a blocking failure that tells the dev how to skip via comment", () => {
        const result = buildMergeGateCheckResult({
            errored: false,
            verdict: verdict({ state: "bug_found", bugCount: 2, investigatedCount: 2 }),
            clientBugTitles: ["Login button does nothing", "Checkout throws 500"],
        });

        expect(result.conclusion).toBe("failure");
        expect(result.summary).toContain(MERGE_GATE_SKIP_COMMAND);
        expect(result.summary).toContain("Login button does nothing");
        expect(result.summary).toContain("Checkout throws 500");
    });

    it("maps a clean pass to success", () => {
        const result = buildMergeGateCheckResult({
            errored: false,
            verdict: verdict({ state: "healthy", investigatedCount: 4 }),
            clientBugTitles: [],
        });

        expect(result.conclusion).toBe("success");
    });

    it("maps a pass with coverage gaps to a non-blocking neutral warning", () => {
        const result = buildMergeGateCheckResult({
            errored: false,
            verdict: verdict({ state: "not_confirmed", coverageGapCount: 3, investigatedCount: 5 }),
            clientBugTitles: [],
        });

        expect(result.conclusion).toBe("neutral");
    });

    it("blocks under the ledger's own count, and points at the comment when no title came with it", () => {
        const result = buildMergeGateCheckResult({
            errored: false,
            verdict: verdict({ state: "bug_found", bugCount: 1, investigatedCount: 2 }),
            clientBugTitles: [],
        });

        expect(result.conclusion).toBe("failure");
        expect(result.title).toBe("Autonoma found 1 client bug");
        // A blocking check that names no bug reads as a mistake, so it points at where the bugs are listed.
        expect(result.summary).toContain("See the Autonoma PR comment");
        expect(result.summary).toContain(MERGE_GATE_SKIP_COMMAND);
    });

    it("passes a run that decided no test was needed, under a title that is not a verified run's", () => {
        const decided = buildMergeGateCheckResult({
            errored: false,
            verdict: verdict({ state: "no_tests_needed" }),
            clientBugTitles: [],
        });
        const verified = buildMergeGateCheckResult({
            errored: false,
            verdict: verdict({ state: "healthy", investigatedCount: 4 }),
            clientBugTitles: [],
        });

        // `success` gates neither of them; the title is the only thing separating the two outcomes.
        expect(decided.conclusion).toBe("success");
        expect(verified.conclusion).toBe("success");
        expect(decided.title).toBe("No tests needed for this change");
        expect(decided.title).not.toBe(verified.title);
        expect(decided.summary).not.toContain("was not verified");
    });

    it("fails open to neutral when the analysis job errored, regardless of the verdict it carries", () => {
        const result = buildMergeGateCheckResult({
            errored: true,
            verdict: verdict({ state: "bug_found", bugCount: 1, investigatedCount: 2 }),
            clientBugTitles: ["ignored while errored"],
        });

        expect(result.conclusion).toBe("neutral");
    });

    it("collapses a long bug list into a '+N more' line", () => {
        const headlines = Array.from({ length: 13 }, (_, index) => `bug ${index + 1}`);
        const result = buildMergeGateCheckResult({
            errored: false,
            verdict: verdict({ state: "bug_found", bugCount: 13, investigatedCount: 13 }),
            clientBugTitles: headlines,
        });

        expect(result.summary).toContain("and 3 more");
        expect(result.summary).toContain("bug 10");
        expect(result.summary).not.toContain("bug 11");
    });
});

describe("parseSkipCommand", () => {
    it("parses the bare command with no reason", () => {
        expect(parseSkipCommand("/autonoma-skip")).toEqual({});
        expect(parseSkipCommand("  /autonoma-skip  ")).toEqual({});
    });

    it("captures the trimmed free-text reason after the command", () => {
        expect(parseSkipCommand("/autonoma-skip hotfix")).toEqual({ reason: "hotfix" });
        expect(parseSkipCommand("/autonoma-skip  fixing in a follow-up PR ")).toEqual({
            reason: "fixing in a follow-up PR",
        });
    });

    it("captures a multi-line reason (the remainder after the command)", () => {
        expect(parseSkipCommand("/autonoma-skip\nnot relevant to this change")).toEqual({
            reason: "not relevant to this change",
        });
    });

    it("handles the CRLF line endings and tabs GitHub sends in comment bodies", () => {
        expect(parseSkipCommand("/autonoma-skip\r\nfixing in a follow-up")).toEqual({
            reason: "fixing in a follow-up",
        });
        expect(parseSkipCommand("/autonoma-skip\thotfix")).toEqual({ reason: "hotfix" });
    });

    it("ignores comments that are not the skip command", () => {
        expect(parseSkipCommand("looks good to me")).toBeUndefined();
        expect(parseSkipCommand("please /autonoma-skip this")).toBeUndefined();
        // A longer command that merely shares the prefix must not match.
        expect(parseSkipCommand("/autonoma-skip-later")).toBeUndefined();
    });
});
