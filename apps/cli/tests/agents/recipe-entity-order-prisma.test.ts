import { describe, expect, test } from "vitest";
import type { AuditedModel } from "../../src/agents/04-recipe-builder/entity-order";
import { resolveEntityOrder } from "../../src/agents/04-recipe-builder/entity-order";
import { rankEntitiesByImportance } from "../../src/agents/04-recipe-builder/entity-relevance";
import { getModel } from "../../src/core/model";

/**
 * A faithful (if trimmed) `AuditedModel[]` derived from the real Autonoma Prisma
 * schema the user shared. It mixes:
 *  - core platform roots (Organization, User, Application),
 *  - dual models created both standalone and as a side effect of an owner
 *    (Member ← Organization, Branch ← Application) to exercise topology,
 *  - pure dependents excluded from the factory order (Account, Session, ...),
 *  - a niche, client-specific table (AccessibilityReport) that today sorts to
 *    the top alphabetically but should rank LAST by importance.
 */
const SCHEMA_MODELS: AuditedModel[] = [
    // ── Core platform roots ──
    {
        name: "Organization",
        independently_created: true,
        created_by: [],
        side_effects: ["creates founding Member", "creates BillingCustomer", "creates BillingPricing"],
    },
    {
        name: "User",
        independently_created: true,
        created_by: [],
        side_effects: ["creates Account", "creates Session"],
    },
    {
        name: "Application",
        independently_created: true,
        created_by: [],
        side_effects: ["creates main Branch", "creates OnboardingState"],
    },

    // ── Dual models: standalone path AND produced by an owner's flow ──
    {
        name: "Member",
        independently_created: true,
        created_by: [{ owner: "Organization", why: "founding member created with the org" }],
    },
    {
        name: "Branch",
        independently_created: true,
        created_by: [{ owner: "Application", why: "main branch created with the application" }],
    },
    {
        name: "BillingCustomer",
        independently_created: true,
        created_by: [{ owner: "Organization", why: "billing customer provisioned at org creation" }],
    },

    // ── Pure dependents (independently_created: false → excluded from factory order) ──
    { name: "Account", independently_created: false, created_by: [{ owner: "User" }] },
    { name: "Session", independently_created: false, created_by: [{ owner: "User" }] },
    { name: "OnboardingState", independently_created: false, created_by: [{ owner: "Application" }] },
    { name: "AiCostRecord", independently_created: false, created_by: [{ owner: "Run" }] },

    // ── Other independent roots across the product ──
    { name: "Invitation", independently_created: true, created_by: [] },
    { name: "ApiKey", independently_created: true, created_by: [] },
    { name: "Folder", independently_created: true, created_by: [] },
    { name: "TestCase", independently_created: true, created_by: [] },
    { name: "TestPlan", independently_created: true, created_by: [] },
    { name: "Scenario", independently_created: true, created_by: [] },
    { name: "Run", independently_created: true, created_by: [] },
    { name: "Tag", independently_created: true, created_by: [] },
    { name: "WebhookCall", independently_created: true, created_by: [] },
    { name: "GitHubInstallation", independently_created: true, created_by: [] },
    { name: "GitHubWebhookEvent", independently_created: true, created_by: [] },
    { name: "BillingPromoCode", independently_created: true, created_by: [] },

    // ── The niche, client-specific table ──
    {
        name: "AccessibilityReport",
        independently_created: true,
        created_by: [],
        side_effects: ["client-specific accessibility audit record"],
    },
];

/** Names that go through the factory order (the `[1/N]` loop the user sees). */
const FACTORY_NAMES = SCHEMA_MODELS.filter((m) => m.independently_created).map((m) => m.name);

/** Models a developer would name first when describing this product. */
const CORE = ["Organization", "User", "Application"];
/** Tables a developer would NOT have top of mind. */
const NICHE = ["AccessibilityReport", "GitHubWebhookEvent", "BillingPromoCode"];

function before(order: string[], a: string, b: string): boolean {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return ia !== -1 && ib !== -1 && ia < ib;
}

describe("recipe entity order - Autonoma Prisma schema", () => {
    // The importance ranking the AI is expected to produce: core platform concepts
    // first, the niche client table last. Used to drive the deterministic test
    // without a live model call.
    const expectedImportanceOrder = [
        "Organization",
        "User",
        "Application",
        "Member",
        "Branch",
        "BillingCustomer",
        "Invitation",
        "ApiKey",
        "Folder",
        "TestCase",
        "TestPlan",
        "Scenario",
        "Run",
        "Tag",
        "WebhookCall",
        "GitHubInstallation",
        "BillingPromoCode",
        "GitHubWebhookEvent",
        "AccessibilityReport",
    ];
    const rank = new Map(expectedImportanceOrder.map((name, i) => [name, i]));

    test("today's alphabetical order surfaces the niche table near the top (the bug)", () => {
        const alphabetical = resolveEntityOrder(SCHEMA_MODELS);
        // AccessibilityReport sorts to the very front alphabetically - exactly the
        // cognitive-load problem this feature fixes.
        expect(alphabetical[0]).toBe("AccessibilityReport");
        expect(before(alphabetical, "AccessibilityReport", "Organization")).toBe(true);
    });

    test("importance ranking opens on a core entity, not the niche table", () => {
        const order = resolveEntityOrder(SCHEMA_MODELS, rank);
        expect(order[0]).toBe("Organization");
        expect(CORE).toContain(order[0]);
        expect(order[0]).not.toBe("AccessibilityReport");
    });

    test("every core entity precedes every niche table", () => {
        const order = resolveEntityOrder(SCHEMA_MODELS, rank);
        for (const core of CORE) {
            for (const niche of NICHE) {
                expect(before(order, core, niche)).toBe(true);
            }
        }
    });

    test("the niche client table lands in the last third", () => {
        const order = resolveEntityOrder(SCHEMA_MODELS, rank);
        expect(order.indexOf("AccessibilityReport")).toBeGreaterThanOrEqual(Math.floor(order.length * (2 / 3)));
    });

    test("topological correctness holds: owners precede their side-effect dependents", () => {
        const order = resolveEntityOrder(SCHEMA_MODELS, rank);
        expect(before(order, "Organization", "Member")).toBe(true);
        expect(before(order, "Organization", "BillingCustomer")).toBe(true);
        expect(before(order, "Application", "Branch")).toBe(true);
    });

    test("only independently-created models appear in the factory order", () => {
        const order = resolveEntityOrder(SCHEMA_MODELS, rank);
        expect(order.sort()).toEqual([...FACTORY_NAMES].sort());
        expect(order).not.toContain("Account"); // pure dependent, built via User
        expect(order).not.toContain("OnboardingState"); // pure dependent, built via Application
    });
});

/**
 * Live validation that the AI itself ranks this schema sensibly. Skipped unless
 * AUTONOMA_API_TOKEN is set (keeps CI offline/deterministic), mirroring the
 * gated 00-pages-finder agent test. When run live it goes through the managed
 * LLM proxy at AUTONOMA_API_URL with that token.
 */
function renderAuditMarkdown(models: AuditedModel[]): string {
    const lines = ["---", `model_count: ${models.length}`, "models:"];
    for (const m of models) {
        lines.push(`  - name: ${m.name}`);
        lines.push(`    independently_created: ${m.independently_created}`);
        if (m.side_effects?.length) {
            lines.push("    side_effects:");
            for (const s of m.side_effects) lines.push(`      - ${s}`);
        }
        if (m.created_by.length) {
            lines.push("    created_by:");
            for (const c of m.created_by) {
                lines.push(`      - owner: ${c.owner}`);
                if (c.why) lines.push(`        why: ${c.why}`);
            }
        } else {
            lines.push("    created_by: []");
        }
    }
    lines.push("---", "# Entity Audit");
    return lines.join("\n");
}

describe.skipIf(!process.env.AUTONOMA_API_TOKEN)("recipe entity order - live AI ranking", () => {
    test("the AI ranks core entities above the niche client table", async () => {
        const auditMarkdown = renderAuditMarkdown(SCHEMA_MODELS);
        const rank = await rankEntitiesByImportance(SCHEMA_MODELS, auditMarkdown, getModel());

        // Ranking must be complete and cover every model exactly once.
        expect(rank.size).toBe(SCHEMA_MODELS.length);

        const order = resolveEntityOrder(SCHEMA_MODELS, rank);

        // The core, recognizable entities must beat the niche client table.
        expect(before(order, "Organization", "AccessibilityReport")).toBe(true);
        expect(before(order, "User", "AccessibilityReport")).toBe(true);
        expect(before(order, "Application", "AccessibilityReport")).toBe(true);

        // A core entity opens the loop; the niche table does not.
        expect(CORE).toContain(order[0]);
        expect(order[0]).not.toBe("AccessibilityReport");

        // The niche table sits in the back half.
        expect(order.indexOf("AccessibilityReport")).toBeGreaterThanOrEqual(Math.floor(order.length / 2));
    }, 60_000);
});
