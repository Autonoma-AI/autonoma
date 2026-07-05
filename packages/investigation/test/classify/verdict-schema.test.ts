import { describe, expect, it } from "vitest";
import { type VerdictForModel, toRunVerdict } from "../../src";

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
            secondaryObservations: [],
            evidence: [{ source: "code", detail: "renamed", file: "a.tsx", lines: null, snippet: "<Toggle/>" }],
            keyStepIndex: null,
        };

        const verdict = toRunVerdict(modelVerdict);

        expect(verdict.suggestedTestUpdate).toBeUndefined();
        expect(verdict.category).toBe("outdated_test");
        expect(verdict.evidence[0]?.file).toBe("a.tsx");
        expect(verdict.evidence[0]?.lines).toBeUndefined();
        expect(verdict.evidence[0]?.snippet).toBe("<Toggle/>");
        expect(verdict.keyStepIndex).toBeUndefined();
        // An empty secondary-observation list normalizes to undefined (nothing else was visibly broken).
        expect(verdict.secondaryObservations).toBeUndefined();
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
            secondaryObservations: [
                {
                    category: "client_bug",
                    confidence: "medium",
                    headline: "Raw owner id overlaps the contact name",
                    detail: "In the billing-contact card the internal owner id renders on top of the display name.",
                },
            ],
            evidence: [{ source: "run", detail: "ok", file: null, lines: null, snippet: null }],
            keyStepIndex: 4,
        };

        expect(toRunVerdict(modelVerdict).suggestedTestUpdate).toBe("Setup: ...");
        expect(toRunVerdict(modelVerdict).keyStepIndex).toBe(4);
        // A populated list is preserved so each observation can become its own finding downstream.
        expect(toRunVerdict(modelVerdict).secondaryObservations).toHaveLength(1);
        expect(toRunVerdict(modelVerdict).secondaryObservations?.[0]?.category).toBe("client_bug");
    });
});
