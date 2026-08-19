import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";
import type { AutonomaCommentPayload, AutonomaCommentPreview } from "./types";

/** A minimal `pr`-kind payload; individual tests override the fields they exercise. */
function prPayload(overrides: Partial<AutonomaCommentPayload> = {}): AutonomaCommentPayload {
    return {
        state: "running",
        kind: "pr",
        prNumber: 42,
        title: "Autonoma - analyzing this PR",
        headline: "Autonoma is analyzing this PR.",
        ctas: [],
        services: [],
        bugs: [],
        notes: [],
        flowGroups: [],
        warnings: [],
        details: [],
        previewUrls: [],
        ...overrides,
    };
}

describe("renderMarkdown - unified pr comment", () => {
    it("renders the dash-form title verbatim and the headline without a state badge", () => {
        const markdown = renderMarkdown(prPayload());
        expect(markdown).toContain("## Autonoma - analyzing this PR");
        expect(markdown).toContain("Autonoma is analyzing this PR.");
        // The pr comment states its outcome in words, like the analysis comment - never a "**RUNNING** -" badge.
        expect(markdown).not.toContain("**RUNNING**");
    });

    it("shows a title icon only for a bug (critical), never for a mid-flight state", () => {
        expect(renderMarkdown(prPayload({ state: "running" }))).not.toContain("## 🟡");
        expect(renderMarkdown(prPayload({ state: "healthy" }))).not.toContain("## 🟢");
        const critical = renderMarkdown(prPayload({ state: "critical", title: "Autonoma - found 1 bug in this PR" }));
        expect(critical).toContain("## 🔴 Autonoma - found 1 bug in this PR");
    });

    it("renders section 1 (preview) above the headline, with its state icon and link", () => {
        const preview: AutonomaCommentPreview = {
            state: "running",
            status: "Building the preview environment",
            link: { label: "See preview", href: "https://preview.example.com" },
        };
        const markdown = renderMarkdown(prPayload({ preview }));
        expect(markdown).toContain(
            "🟡 Building the preview environment · [See preview](<https://preview.example.com>)",
        );
        // Section 1 precedes the analysis headline.
        expect(markdown.indexOf("Building the preview environment")).toBeLessThan(
            markdown.indexOf("Autonoma is analyzing this PR."),
        );
    });

    it("omits section 1 for a BYO-preview org (no preview field)", () => {
        const markdown = renderMarkdown(prPayload());
        expect(markdown).not.toContain("Building the preview environment");
    });

    it("renders a failed preview with a red icon", () => {
        const preview: AutonomaCommentPreview = { state: "critical", status: "The preview build failed" };
        const markdown = renderMarkdown(prPayload({ preview }));
        expect(markdown).toContain("🔴 The preview build failed");
    });
});
