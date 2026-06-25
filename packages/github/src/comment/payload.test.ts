import { describe, expect, it } from "vitest";
import { resolveCommentAssetBaseUrl } from "./assets";
import { renderMarkdown } from "./markdown";
import { payloadBuilder } from "./payload";

describe("resolveCommentAssetBaseUrl", () => {
    it("uses the explicit asset base URL when configured", () => {
        expect(
            resolveCommentAssetBaseUrl({
                explicitAssetBaseUrl: "https://cdn.autonoma.app/github-comment/",
                appUrl: "https://autonoma.app",
            }),
        ).toBe("https://cdn.autonoma.app/github-comment/");
    });

    it("defaults to the app URL github-comment directory", () => {
        expect(resolveCommentAssetBaseUrl({ appUrl: "https://autonoma.app" })).toBe(
            "https://autonoma.app/github-comment/",
        );
    });
});

describe("payloadBuilder", () => {
    it("orders the primary CTAs as Open in Autonoma, See preview", () => {
        const payload = payloadBuilder({
            state: "critical",
            prNumber: 42,
            commitSha: "abc123456789",
            summaryUrl: "https://autonoma.app/summary",
            previewUrl: "https://preview.example.com",
            bugs: [{ title: "Checkout button is hidden", href: "https://autonoma.app/bug/1" }],
        });

        expect(payload.ctas.map((cta) => cta.label)).toEqual(["Open in Autonoma", "See preview"]);
        expect(renderMarkdown(payload)).toContain(
            "[↗ Open in Autonoma](https://autonoma.app/summary) | [👁 See preview]",
        );
    });

    it("renders SVG status pill, issue dot, and CTA images when assetBaseUrl is configured", () => {
        const markdown = renderMarkdown(
            payloadBuilder({
                state: "critical",
                prNumber: 42,
                assetBaseUrl: "https://cdn.autonoma.app/github-comment/",
                summaryUrl: "https://autonoma.app/summary",
                previewUrl: "https://preview.example.com",
                bugs: [{ title: "Checkout button is hidden", occurrenceCount: 4 }],
            }),
        );

        // Status pill replaces the **UNHEALTHY** - headline text.
        expect(markdown).toContain(
            '<img src="https://cdn.autonoma.app/github-comment/status-critical-pill.svg" alt="UNHEALTHY" width="126" />',
        );
        expect(markdown).not.toContain("**UNHEALTHY** -");

        // Issue dot replaces the 🔴 emoji marker, no `- ` bullet prefix.
        expect(markdown).toContain(
            '<img src="https://cdn.autonoma.app/github-comment/status-dot-red.svg" width="12" height="12" alt="" />',
        );
        expect(markdown).toContain("`x4`");

        // CTA buttons replace the text links.
        expect(markdown).toContain(
            '<a href="https://autonoma.app/summary"><img src="https://cdn.autonoma.app/github-comment/open-in-autonoma-button-v2.svg" alt="Open in Autonoma" width="150" /></a>',
        );
        expect(markdown).toContain(
            '<a href="https://preview.example.com"><img src="https://cdn.autonoma.app/github-comment/see-preview-button-v2.svg" alt="See preview" width="150" /></a>',
        );
    });

    it("renders the rich GitHub comment hierarchy for critical PRs", () => {
        const markdown = renderMarkdown(
            payloadBuilder({
                state: "critical",
                prNumber: 42,
                commitSha: "abc123456789",
                duration: "1m22s",
                summaryUrl: "https://autonoma.app/app/demo/pull-requests/42/snapshots/snap_123",
                previewUrl: "https://preview.example.com",
                tests: { selected: 12, passed: 9, failed: 3 },
                bugs: [
                    {
                        title: "Checkout button is hidden",
                        href: "https://autonoma.app/bug/1",
                        occurrenceCount: 4,
                    },
                    {
                        title: "Plan selector loses focus",
                        href: "https://autonoma.app/bug/2",
                        occurrenceCount: 2,
                    },
                    { title: "Settings page 500s", href: "https://autonoma.app/bug/3", occurrenceCount: 1 },
                ],
            }),
        );

        expect(markdown).toContain("## 🔴 Autonoma found 3 bugs in this PR");
        expect(markdown).toContain("**UNHEALTHY** - Autonoma found 3 bugs in this PR.");
        expect(markdown).toContain("**Tests** `12`");
        expect(markdown).toContain("**Pass rate** `75%`");
        expect(markdown).toContain("**Bugs** `3`");
        expect(markdown).toContain("**Failed** `3`");
        expect(markdown).toContain("**Duration** `1m22s`");
        expect(markdown).toContain("**Top issues**");
        expect(markdown).toContain("🔴 [Checkout button is hidden](https://autonoma.app/bug/1) `x4`");
        expect(markdown).toContain(
            "[↗ Open in Autonoma](https://autonoma.app/app/demo/pull-requests/42/snapshots/snap_123)",
        );
        expect(markdown).toContain("Triggered by commit `abc1234`");
    });

    it("renders grouped Services and Addons sections and a warnings callout", () => {
        const markdown = renderMarkdown(
            payloadBuilder({
                state: "running",
                prNumber: 12,
                services: [{ name: "web", status: "ready", url: "https://web.example.com" }],
                addons: [{ name: "db", provider: "neon", status: "ready" }],
                warnings: ["acme/api branch feature-x not found; used main instead."],
            }),
        );

        expect(markdown).toContain("**Services:**");
        expect(markdown).toContain("**Addons:**");
        expect(markdown).toContain("- db (neon) - Ready");
        expect(markdown).toContain("> **Note:**");
        expect(markdown).toContain("> - acme/api branch feature-x not found; used main instead.");
    });

    it("does not label failed tests as bugs when no bug records exist", () => {
        const markdown = renderMarkdown(
            payloadBuilder({
                state: "critical",
                prNumber: 42,
                tests: { selected: 3, passed: 1, failed: 2 },
            }),
        );

        expect(markdown).not.toContain("**Bugs** `2`");
        expect(markdown).toContain("**Failed** `2`");
    });

    it("escapes HTML in markdown-rendered user content", () => {
        const markdown = renderMarkdown(
            payloadBuilder({
                state: "critical",
                prNumber: 42,
                bugs: [{ title: '<img src=x onerror="alert(1)">', href: "https://autonoma.app/bug/1" }],
                services: [{ name: "<api>", status: "failed", url: "https://api.example.com" }],
                warnings: ["<script>alert(1)</script> & retry"],
            }),
        );

        expect(markdown).not.toContain("<img src=x");
        expect(markdown).not.toContain("<api>");
        expect(markdown).not.toContain("<script>");
        expect(markdown).toContain('&lt;img src=x onerror="alert(1)"&gt;');
        expect(markdown).toContain("&lt;api&gt;");
        expect(markdown).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; retry");
    });

    it("labels unknown state distinctly in user-facing copy", () => {
        const markdown = renderMarkdown(
            payloadBuilder({
                state: "unknown",
                prNumber: 3,
                message: "Build failed in *api*",
            }),
        );

        expect(markdown).toContain("**UNKNOWN** - Build failed in \\*api\\*");
    });

    it("renders markdown-safe user-provided content and fences code blocks longer than embedded backtick runs", () => {
        const markdown = renderMarkdown(
            payloadBuilder({
                state: "unknown",
                prNumber: 3,
                services: [{ name: "api|server", status: "failed", error: "```secret```" }],
            }),
        );

        // Service name retains escaped pipe inside its table cell.
        expect(markdown).toContain("api\\|server");
        // Error body is fenced with 4 backticks (one longer than its longest backtick run),
        // so the original `\`\`\`secret\`\`\`` content survives intact in the rendered comment.
        expect(markdown).toContain("````\n```secret```\n````");
    });
});
