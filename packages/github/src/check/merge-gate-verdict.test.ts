import { describe, expect, it } from "vitest";
import { buildMergeGateCheckResult, MERGE_GATE_SKIP_COMMAND, parseSkipCommand } from "./merge-gate-verdict";

describe("buildMergeGateCheckResult", () => {
    it("maps a client_bug verdict to a blocking failure that tells the dev how to skip via comment", () => {
        const result = buildMergeGateCheckResult({
            verdict: "client_bug",
            errored: false,
            coverageGapCount: 0,
            clientBugHeadlines: ["Login button does nothing", "Checkout throws 500"],
        });

        expect(result.conclusion).toBe("failure");
        expect(result.summary).toContain(MERGE_GATE_SKIP_COMMAND);
        expect(result.summary).toContain("Login button does nothing");
        expect(result.summary).toContain("Checkout throws 500");
    });

    it("maps a clean pass to success", () => {
        const result = buildMergeGateCheckResult({
            verdict: "passed",
            errored: false,
            coverageGapCount: 0,
            clientBugHeadlines: [],
        });

        expect(result.conclusion).toBe("success");
    });

    it("maps a pass with coverage gaps to a non-blocking neutral warning", () => {
        const result = buildMergeGateCheckResult({
            verdict: "passed",
            errored: false,
            coverageGapCount: 3,
            clientBugHeadlines: [],
        });

        expect(result.conclusion).toBe("neutral");
    });

    it("fails open to neutral when the analysis job errored, regardless of the stale verdict", () => {
        const result = buildMergeGateCheckResult({
            verdict: "client_bug",
            errored: true,
            coverageGapCount: 0,
            clientBugHeadlines: ["ignored while errored"],
        });

        expect(result.conclusion).toBe("neutral");
    });

    it("collapses a long bug list into a '+N more' line", () => {
        const headlines = Array.from({ length: 13 }, (_, index) => `bug ${index + 1}`);
        const result = buildMergeGateCheckResult({
            verdict: "client_bug",
            errored: false,
            coverageGapCount: 0,
            clientBugHeadlines: headlines,
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
