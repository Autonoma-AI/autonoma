import { describe, expect, test } from "vitest";
import { renderContent, wrapStyledLines, type StyledLine } from "../../src/ui/components/render-content";

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
});
