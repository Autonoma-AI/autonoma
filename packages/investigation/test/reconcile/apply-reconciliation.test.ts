import type { InvestigationFinding } from "@autonoma/types";
import { describe, expect, it } from "vitest";
import { applyReconciliation } from "../../src/reconcile/apply-reconciliation";
import { ReconciliationForModel, toReconciliationResult } from "../../src/reconcile/schema";

function finding(id: string, over: Partial<InvestigationFinding> = {}): InvestigationFinding {
    return {
        id,
        slug: id,
        category: "scenario_issue",
        headline: `headline ${id}`,
        evidence: [{ source: "code", detail: `evidence ${id}`, file: `${id}.ts`, lines: "1-2" }],
        ...over,
    };
}

describe("toReconciliationResult (validation)", () => {
    const ids = new Set(["a", "b", "c", "d"]);

    it("keeps a clean merge and normalizes null remediation to undefined", () => {
        const result = toReconciliationResult(
            ReconciliationForModel.parse({
                merges: [
                    {
                        memberIds: ["a", "b"],
                        canonicalId: "a",
                        headline: "h",
                        rootCause: "r",
                        remediation: null,
                        reason: "same",
                    },
                ],
            }),
            ids,
        );
        expect(result.merges).toHaveLength(1);
        expect(result.merges[0]?.memberIds).toEqual(["a", "b"]);
        expect(result.merges[0]?.remediation).toBeUndefined();
    });

    it("drops unknown ids and skips a merge that falls below two members", () => {
        const result = toReconciliationResult(
            ReconciliationForModel.parse({
                merges: [
                    {
                        memberIds: ["a", "zzz"],
                        canonicalId: "a",
                        headline: "h",
                        rootCause: "r",
                        remediation: null,
                        reason: "x",
                    },
                ],
            }),
            ids,
        );
        expect(result.merges).toEqual([]);
    });

    it("promotes the first member when the canonical is not one of the members", () => {
        const result = toReconciliationResult(
            ReconciliationForModel.parse({
                merges: [
                    {
                        memberIds: ["a", "b"],
                        canonicalId: "c",
                        headline: "h",
                        rootCause: "r",
                        remediation: null,
                        reason: "x",
                    },
                ],
            }),
            ids,
        );
        expect(result.merges[0]?.canonicalId).toBe("a");
    });

    it("never lets one finding be claimed by two merges (a clean partition)", () => {
        const result = toReconciliationResult(
            ReconciliationForModel.parse({
                merges: [
                    {
                        memberIds: ["a", "b"],
                        canonicalId: "a",
                        headline: "h1",
                        rootCause: "r",
                        remediation: null,
                        reason: "x",
                    },
                    {
                        memberIds: ["b", "c"],
                        canonicalId: "c",
                        headline: "h2",
                        rootCause: "r",
                        remediation: null,
                        reason: "y",
                    },
                ],
            }),
            ids,
        );
        // The second merge loses `b` (already claimed) and then has only `c` left -> dropped entirely.
        expect(result.merges).toHaveLength(1);
        expect(result.merges[0]?.memberIds).toEqual(["a", "b"]);
    });
});

describe("applyReconciliation", () => {
    it("collapses a merge into the canonical, unions evidence, sets coveredSlugs, and drops absorbed members", () => {
        const findings = [finding("a"), finding("b"), finding("c")];
        const merged = applyReconciliation(findings, {
            merges: [
                {
                    memberIds: ["a", "c"],
                    canonicalId: "a",
                    headline: "combined",
                    rootCause: "combined cause",
                    remediation: "fix both",
                    reason: "same",
                },
            ],
        });

        // b is untouched; a is the merged finding; c is gone.
        expect(merged.map((f) => f.id)).toEqual(["a", "b"]);
        const canonical = merged.find((f) => f.id === "a");
        expect(canonical?.headline).toBe("combined");
        expect(canonical?.rootCause).toBe("combined cause");
        expect(canonical?.remediation).toBe("fix both");
        expect(canonical?.coveredSlugs).toEqual(["a", "c"]);
        // Evidence is the union of a's and c's (deduped), so both files are present.
        expect(canonical?.evidence.map((e) => e.file)).toEqual(["a.ts", "c.ts"]);
        // The standalone finding carries no coveredSlugs.
        expect(merged.find((f) => f.id === "b")?.coveredSlugs).toBeUndefined();
    });

    it("preserves order: the merged finding stays where its canonical was", () => {
        const findings = [finding("a"), finding("b"), finding("c"), finding("d")];
        const merged = applyReconciliation(findings, {
            merges: [{ memberIds: ["b", "d"], canonicalId: "d", headline: "h", rootCause: "r", reason: "same" }],
        });
        // b absorbed into d; d keeps its slot; the surviving order is a, c, d.
        expect(merged.map((f) => f.id)).toEqual(["a", "c", "d"]);
        expect(merged.find((f) => f.id === "d")?.coveredSlugs).toEqual(["b", "d"]);
    });

    it("is a no-op when there are no merges", () => {
        const findings = [finding("a"), finding("b")];
        expect(applyReconciliation(findings, { merges: [] })).toBe(findings);
    });
});
