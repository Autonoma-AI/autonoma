import { describe, expect, it } from "vitest";
import { buildMergeGateCheckResult, MERGE_GATE_SKIP_ACTION_IDENTIFIER } from "./merge-gate-verdict";

describe("buildMergeGateCheckResult", () => {
    it("maps a client_bug verdict to a blocking failure that carries the Skip action", () => {
        const result = buildMergeGateCheckResult({
            verdict: "client_bug",
            errored: false,
            coverageGapCount: 0,
            clientBugHeadlines: ["Login button does nothing", "Checkout throws 500"],
        });

        expect(result.conclusion).toBe("failure");
        expect(result.actions).toHaveLength(1);
        expect(result.actions?.[0]?.identifier).toBe(MERGE_GATE_SKIP_ACTION_IDENTIFIER);
        expect(result.summary).toContain("Login button does nothing");
        expect(result.summary).toContain("Checkout throws 500");
    });

    it("maps a clean pass to success with no action", () => {
        const result = buildMergeGateCheckResult({
            verdict: "passed",
            errored: false,
            coverageGapCount: 0,
            clientBugHeadlines: [],
        });

        expect(result.conclusion).toBe("success");
        expect(result.actions).toBeUndefined();
    });

    it("maps a pass with coverage gaps to a non-blocking neutral warning", () => {
        const result = buildMergeGateCheckResult({
            verdict: "passed",
            errored: false,
            coverageGapCount: 3,
            clientBugHeadlines: [],
        });

        expect(result.conclusion).toBe("neutral");
        expect(result.actions).toBeUndefined();
    });

    it("fails open to neutral when the analysis job errored, regardless of the stale verdict", () => {
        const result = buildMergeGateCheckResult({
            verdict: "client_bug",
            errored: true,
            coverageGapCount: 0,
            clientBugHeadlines: ["ignored while errored"],
        });

        expect(result.conclusion).toBe("neutral");
        expect(result.actions).toBeUndefined();
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
