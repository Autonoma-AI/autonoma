import { describe, expect, it } from "vitest";
import { type VerdictForModel, toRunVerdict } from "../../src/classify/verdict-schema";

describe("toRunVerdict", () => {
    it("maps the model's nullable fields to undefined and preserves the rest", () => {
        const modelVerdict: VerdictForModel = {
            category: "outdated_test",
            isClientBug: false,
            ran: true,
            confidence: "high",
            planFidelity: "diverged",
            headline: "the toggle moved",
            falsePositiveRisk: "intended change",
            whatHappened: "reached the page",
            rootCause: "element renamed",
            remediation: "update the selector",
            suggestedTestUpdate: null,
            observedAppIssues: null,
            evidence: [{ source: "code", detail: "renamed", file: "a.tsx", lines: null, snippet: "<Toggle/>" }],
        };

        const verdict = toRunVerdict(modelVerdict);

        expect(verdict.suggestedTestUpdate).toBeUndefined();
        expect(verdict.category).toBe("outdated_test");
        expect(verdict.evidence[0]?.file).toBe("a.tsx");
        expect(verdict.evidence[0]?.lines).toBeUndefined();
        expect(verdict.evidence[0]?.snippet).toBe("<Toggle/>");
    });

    it("keeps a present suggestedTestUpdate", () => {
        const modelVerdict: VerdictForModel = {
            category: "passed",
            isClientBug: false,
            ran: true,
            confidence: "high",
            planFidelity: "partial",
            headline: "passed",
            falsePositiveRisk: "none",
            whatHappened: "ok",
            rootCause: "ok",
            remediation: "tighten",
            suggestedTestUpdate: "Setup: ...",
            observedAppIssues: "the results list rendered empty where listings were expected",
            evidence: [{ source: "run", detail: "ok", file: null, lines: null, snippet: null }],
        };

        expect(toRunVerdict(modelVerdict).suggestedTestUpdate).toBe("Setup: ...");
    });
});
