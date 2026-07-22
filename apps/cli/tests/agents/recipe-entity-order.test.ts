import { describe, expect, test } from "vitest";
import type { AuditedModel } from "../../src/agents/04-recipe-builder/entity-order";
import { resolveEntityOrder } from "../../src/agents/04-recipe-builder/entity-order";

function root(name: string): AuditedModel {
    return { name, independently_created: true, created_by: [] };
}

function dependent(name: string, owner: string): AuditedModel {
    return { name, independently_created: true, created_by: [{ owner }] };
}

describe("resolveEntityOrder", () => {
    test("falls back to alphabetical tie-break when no rank is given", () => {
        const models = [root("Charlie"), root("Alpha"), root("Bravo")];
        expect(resolveEntityOrder(models)).toEqual(["Alpha", "Bravo", "Charlie"]);
    });

    test("orders important roots first when a rank is supplied", () => {
        const models = [root("AccessibilityReport"), root("Organization"), root("User")];
        const rank = new Map([
            ["Organization", 0],
            ["User", 1],
            ["AccessibilityReport", 2],
        ]);
        expect(resolveEntityOrder(models, rank)).toEqual(["Organization", "User", "AccessibilityReport"]);
    });

    test("preserves the topological invariant: an owner precedes its dependent", () => {
        // Child is more "important" than its owner, but must still come after it.
        const models = [dependent("Child", "Owner"), root("Owner")];
        const rank = new Map([
            ["Child", 0],
            ["Owner", 1],
        ]);
        const order = resolveEntityOrder(models, rank);
        expect(order.indexOf("Owner")).toBeLessThan(order.indexOf("Child"));
    });

    test("ranks among simultaneously-available entities, not globally", () => {
        // Two roots + one dependent of the lower-ranked root. The high-rank root
        // surfaces first; the dependent only becomes available after its owner.
        const models = [root("Org"), root("Niche"), dependent("OrgChild", "Org")];
        const rank = new Map([
            ["Org", 0],
            ["OrgChild", 1],
            ["Niche", 2],
        ]);
        expect(resolveEntityOrder(models, rank)).toEqual(["Org", "OrgChild", "Niche"]);
    });
});
