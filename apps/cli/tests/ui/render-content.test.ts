import { describe, expect, test } from "vitest";
import type { CoreFlowsSpec } from "../../src/agents/01-kb-generator/flow-spec";
import { buildRunPlan, planBudget, targetTestCount } from "../../src/agents/05-test-generator/budget";
import { renderContent, wrapStyledLines, type StyledLine } from "../../src/ui/components/render-content";
import type { RunPlan } from "../../src/ui/types";

function textOf(lines: StyledLine[]): string[] {
    return lines.map((spans) => spans.map((s) => s.text).join(""));
}

describe("document-aware rendering", () => {
    test("markdown frontmatter renders as an info card, not raw YAML", () => {
        const doc = [
            "---",
            'app_name: "Acme"',
            "feature_count: 12",
            "pages:",
            '  - page: "/settings"',
            '    description: "All the settings"',
            '  - page: "/tags"',
            '    description: "Tag overview"',
            "---",
            "",
            "# Body heading",
            "Some prose.",
        ].join("\n");

        const lines = textOf(renderContent(doc, "markdown", "AUTONOMA.md"));
        const all = lines.join("\n");
        // Scalars become key/value rows; arrays become labeled tables.
        expect(all).toContain("app_name  Acme");
        expect(all).toContain("feature_count  12");
        expect(all).toContain("pages");
        expect(all).toContain("2 entries");
        expect(all).toMatch(/\/settings\s+All the settings/);
        // No raw YAML syntax leaks through.
        expect(all).not.toContain('- page: "/settings"');
        // The body still renders after the card.
        expect(all).toContain("# Body heading");
    });

    test("test-case frontmatter (flow/category/priority) renders as key/value rows", () => {
        const doc = ["---", "flow: Account", "category: core", "priority: medium", "---", "", "# Update name"].join(
            "\n",
        );
        const all = textOf(renderContent(doc, "markdown", "edit-profile.md")).join("\n");
        expect(all).toContain("flow  Account");
        expect(all).toContain("priority  medium");
        expect(all).toContain("# Update name");
    });

    test("frontmatter uses YAML 1.2 scalar and merge-key semantics", () => {
        const doc = [
            "---",
            "released_on: 2026-08-07",
            "formatted_count: 1_000",
            "reference: 0128",
            "defaults: &defaults",
            "  owner: QA",
            "release:",
            "  <<: *defaults",
            "  name: August release",
            "---",
            "",
            "# Release",
        ].join("\n");
        const all = textOf(renderContent(doc, "markdown", "release.md")).join("\n");
        expect(all).toContain("released_on  2026-08-07");
        expect(all).toContain("formatted_count  1_000");
        expect(all).toContain("reference  128");
        expect(all).toContain('release  {"<<":{"owner":"QA"},"name":"August release"}');
        expect(all).not.toContain("2026-08-07T00:00:00.000Z");
    });

    test("pages.json renders as a route table", () => {
        const doc = JSON.stringify({
            "/settings": { route: "/settings", path: "src/app/settings.tsx", description: "All the settings" },
            "/tags": { route: "/tags", path: "src/app/tags.tsx", description: "Tag overview" },
        });
        const all = textOf(renderContent(doc, "json", "pages.json")).join("\n");
        expect(all).toContain("2 routes");
        expect(all).toMatch(/\/settings\s+All the settings/);
        expect(all).toContain("src/app/tags.tsx");
        expect(all).not.toContain("{");
    });

    test("project-map.json renders as labeled sections, not raw JSON", () => {
        const doc = JSON.stringify({
            frontends: [
                { path: "apps/web-app", framework: "next", dependsOn: ["packages/db"], why: "Main Next.js app." },
            ],
            backends: [{ path: "packages/db", framework: "mongoose", why: "Owns the models." }],
            ignore: [{ path: "infra", why: "Deployment only." }],
        });
        const all = textOf(renderContent(doc, "json", "project-map.json")).join("\n");
        expect(all).toContain("frontends");
        expect(all).toMatch(/apps\/web-app\s+Main Next.js app./);
        expect(all).toContain("dependsOn: packages/db");
        expect(all).toContain("backends");
        expect(all).not.toContain('"path"');
    });

    test("entity-audit.md renders the models as a factory/owner table", () => {
        const doc = [
            "---",
            "model_count: 3",
            "factory_count: 2",
            "models:",
            "  - name: User",
            "    independently_created: true",
            "    creation_file: src/services/user.service.ts",
            "    creation_function: UserService.create",
            "    side_effects:",
            "      - hashes password",
            "    created_by: []",
            "  - name: Settings",
            "    independently_created: false",
            "    created_by:",
            "      - owner: User",
            "        via: UserService.create",
            '        why: "Every new User gets a default Settings row."',
            "  - name: Organization",
            "    independently_created: true",
            "    creation_file: src/services/org.service.ts",
            "    creation_function: OrgService.create",
            "---",
            "",
            "# Audit body",
        ].join("\n");

        const all = textOf(renderContent(doc, "markdown", "entity-audit.md")).join("\n");
        expect(all).toContain("3 total");
        expect(all).toContain("2 with a factory");
        expect(all).toContain("1 created via owners");
        expect(all).toMatch(/User\s+● factory\s+UserService.create/);
        expect(all).toContain("src/services/user.service.ts · side effects: hashes password");
        expect(all).toMatch(/Settings\s+○ via\s+User/);
        expect(all).toContain("Every new User gets a default Settings row.");
        // No raw YAML leaks through, and the body still renders.
        expect(all).not.toContain("independently_created");
        expect(all).toContain("# Audit body");
    });

    test("entity-audit.md without a models array falls back to the generic card", () => {
        const doc = ["---", "model_count: 0", "---", "", "# Nothing found"].join("\n");
        const all = textOf(renderContent(doc, "markdown", "entity-audit.md")).join("\n");
        expect(all).toContain("model_count  0");
        expect(all).toContain("# Nothing found");
    });

    test("broken frontmatter falls back to raw markdown", () => {
        const doc = "---\n: : bad yaml [\n---\n\n# Still readable";
        const all = textOf(renderContent(doc, "markdown", "AUTONOMA.md")).join("\n");
        expect(all).toContain("# Still readable");
    });

    test("other json keeps syntax highlighting untouched", () => {
        const doc = '{ "a": 1 }';
        const all = textOf(renderContent(doc, "json", "recipe.json")).join("\n");
        expect(all).toContain('{ "a": 1 }');
    });
});

describe("wrapStyledLines", () => {
    test("folds long lines at word boundaries, preserving styles", () => {
        const lines: StyledLine[] = [
            [
                { text: "app_description  ", color: "#CCFF00" },
                { text: "A comprehensive real estate platform that allows users to search for properties" },
            ],
        ];
        const wrapped = wrapStyledLines(lines, 40);
        expect(wrapped.length).toBeGreaterThan(1);
        for (const line of wrapped) {
            expect(line.reduce((n, s) => n + s.text.length, 0)).toBeLessThanOrEqual(40);
        }
        // No mid-word cut where a space was available.
        const flat = wrapped.map((l) => l.map((s) => s.text).join(""));
        expect(flat[0]!.endsWith(" ") || /\s$|\w+$/.test(flat[0]!)).toBe(true);
        expect(flat.join(" ")).toContain("comprehensive");
        // The styled prefix keeps its color on the first line.
        expect(wrapped[0]![0]!.color).toBe("#CCFF00");
    });

    test("hard-cuts unbroken runs instead of overflowing", () => {
        const wrapped = wrapStyledLines([[{ text: "x".repeat(100) }]], 30);
        expect(wrapped.length).toBe(4);
        expect(wrapped[0]![0]!.text.length).toBe(30);
    });

    test("indented lines wrap with a hanging indent under their start column", () => {
        const lines: StyledLine[] = [
            [
                { text: " ".repeat(10) },
                { text: "packages/api/src/core/operations side effects: deletes previous documents" },
            ],
        ];
        const wrapped = wrapStyledLines(lines, 40);
        expect(wrapped.length).toBeGreaterThan(1);
        for (const cont of wrapped.slice(1)) {
            const flat = cont.map((s) => s.text).join("");
            // Continuations align under column 10, never snap back to 0.
            expect(flat.startsWith(" ".repeat(10))).toBe(true);
            expect(flat.charAt(10)).not.toBe(" ");
            expect(flat.length).toBeLessThanOrEqual(40);
        }
    });

    test("an absurdly deep indent falls back to no hanging indent", () => {
        const lines: StyledLine[] = [[{ text: " ".repeat(30) + "word ".repeat(20) }]];
        const wrapped = wrapStyledLines(lines, 40);
        for (const cont of wrapped.slice(1)) {
            expect(cont.map((s) => s.text).join("").length).toBeLessThanOrEqual(40);
        }
    });
});

describe("test-plan rendering", () => {
    const PLAN: RunPlan = {
        pitch: "An AI legal assistant for managing matters and documents",
        total: 60,
        smokeFloor: 30,
        tierTotals: { 1: 18, 2: 9, 3: 3 },
        signalsPersisted: false,
        flows: [
            {
                flowId: "intake",
                feature: "Request Intake",
                tier: 1,
                tierReason: "The flow the product is sold on and the highest-defect surface.",
                riskDrivers: ["unconstrained_input", "interruptible_state"],
                entryPoints: ["/triage", "/issues/[id]"],
                invariants: ["A submitted request always reaches a queue"],
                allowance: 18,
            },
            {
                flowId: "settings",
                feature: "Workspace Settings",
                tier: 3,
                tierReason: "Configuration and account management, not the primary user value.",
                riskDrivers: [],
                entryPoints: ["/settings"],
                invariants: [],
                allowance: 3,
            },
        ],
    };

    // The store projects the plan slice to JSON as the live text; render-content
    // dispatches on the test-plan.md name and parses it back into a card.
    const render = (plan: RunPlan) => textOf(renderContent(JSON.stringify(plan), "markdown", "test-plan.md"));

    test("renders a structured card, not raw JSON or prose bullets", () => {
        const all = render(PLAN).join("\n");
        // The header: pitch, then the budget split.
        expect(all).toContain(PLAN.pitch);
        expect(all).toContain("60 tests");
        expect(all).toContain("30 smoke + 30 by importance");
        // Tier sections group the flows.
        expect(all).toContain("Tier 1  what the product is for");
        expect(all).toContain("Tier 3  administration & configuration");
        // Each flow is an aligned row (feature · budget) with labeled fields, not
        // markdown bullets - no leading "- " prose markers survive.
        expect(all).toMatch(/Request Intake\s+18 tests/);
        expect(all).toContain("The flow the product is sold on");
        expect(all).toMatch(/risk\s+unconstrained input · interruptible state/);
        expect(all).toMatch(/entry\s+\/triage · \/issues\/\[id\]/);
        expect(all).not.toContain("**Risk:**");
        expect(all).not.toContain('"tierReason"');
    });

    test("says 'none flagged' when a flow has no risk drivers", () => {
        expect(render(PLAN).join("\n")).toMatch(/risk\s+none flagged/);
    });

    test("is honest that raw git signals are not persisted", () => {
        expect(render(PLAN).join("\n")).toContain("not persisted yet");
    });

    test("falls back rather than throwing on malformed plan text", () => {
        expect(() => renderContent("{ not json", "markdown", "test-plan.md")).not.toThrow();
        expect(() => renderContent(JSON.stringify({ pitch: 1 }), "markdown", "test-plan.md")).not.toThrow();
    });

    test("renders a plan produced by buildRunPlan (guards the schema against drift)", () => {
        const spec: CoreFlowsSpec = {
            pitch: "A product that does a thing for people who need it",
            flows: [
                {
                    id: "core",
                    feature: "Core Flow",
                    description: "the main thing the product does",
                    mission: "must do its one job correctly",
                    tier: 1,
                    tierReason: "because the pitch says so, at some length",
                    invariants: ["the thing always happens"],
                    riskDrivers: ["realtime_async"],
                    entryPoints: ["/core"],
                },
            ],
        };
        const plan = buildRunPlan(spec, planBudget(spec, 20, targetTestCount(20)));
        const all = render(plan).join("\n");
        expect(all).toContain("Core Flow");
        expect(all).toContain("Tier 1  what the product is for");
        expect(all).toMatch(/risk\s+realtime async/);
    });
});
