import { describe, expect, it } from "vitest";
import { validateRecipeGraph } from "../../src";

describe("validateRecipeGraph", () => {
    it("accepts a well-formed graph with resolving refs and template vars", () => {
        const graph = JSON.stringify({
            User: [{ _alias: "admin", email: "admin-{{testRunId}}@x.com" }],
            Invoice: [{ invoiceNumber: "INV-1", createdBy: { _ref: "admin" } }],
        });
        expect(validateRecipeGraph(graph)).toEqual({ valid: true, errors: [] });
    });

    it("rejects non-JSON", () => {
        const result = validateRecipeGraph("{not json");
        expect(result.valid).toBe(false);
        expect(result.errors[0]).toContain("Not valid JSON");
    });

    it("rejects a bare array (must be an object keyed by model)", () => {
        const result = validateRecipeGraph(JSON.stringify([{ email: "a@x.com" }]));
        expect(result.valid).toBe(false);
    });

    it("rejects a model whose value is not an array of records", () => {
        const result = validateRecipeGraph(JSON.stringify({ User: { email: "a@x.com" } }));
        expect(result.valid).toBe(false);
    });

    it("flags a dangling _ref by the alias it points to", () => {
        const graph = JSON.stringify({
            Invoice: [{ invoiceNumber: "INV-1", createdBy: { _ref: "missing_admin" } }],
        });
        const result = validateRecipeGraph(graph);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes("missing_admin"))).toBe(true);
    });

    it("resolves refs nested deep inside fields", () => {
        const graph = JSON.stringify({
            Org: [{ _alias: "org" }],
            Task: [{ meta: { owner: { org: { _ref: "org" } } } }],
        });
        expect(validateRecipeGraph(graph).valid).toBe(true);
    });
});
