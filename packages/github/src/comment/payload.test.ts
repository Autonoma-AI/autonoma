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
            "[↗ Open in Autonoma](<https://autonoma.app/summary>) · [👁 See preview](<https://preview.example.com>)",
        );
    });

    it("renders text-first status with image-button CTAs for Open in Autonoma and See preview", () => {
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

        // No status-pill image: an emoji title + a markdown state label carry the state, so a markdown-only
        // renderer (Linear) still shows it.
        expect(markdown).toContain("## 🔴 ");
        expect(markdown).toContain("**UNHEALTHY** - ");
        expect(markdown).not.toContain("status-critical-pill.svg");
        expect(markdown).not.toContain("<img");

        // The per-bug marker is a colored-dot emoji, never an <img>: an image would hijack the click and
        // open the SVG in a new tab instead of expanding the bug.
        expect(markdown).toContain("🔴 Checkout button is hidden");
        expect(markdown).toContain("`x4`");

        // Both top-level CTAs render as markdown image-links (primary + secondary buttons).
        expect(markdown).toContain(
            "[![Open in Autonoma](<https://cdn.autonoma.app/github-comment/open-in-autonoma-button-v3.svg>)](<https://autonoma.app/summary>)",
        );
        expect(markdown).toContain(
            "[![See preview](<https://cdn.autonoma.app/github-comment/see-preview-button-v3.svg>)](<https://preview.example.com>)",
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
        expect(markdown).toContain("🔴 [Checkout button is hidden](<https://autonoma.app/bug/1>) `x4`");
        expect(markdown).toContain(
            "[↗ Open in Autonoma](<https://autonoma.app/app/demo/pull-requests/42/snapshots/snap_123>)",
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

    it("omits pass rate and duration entirely when there is no data (not-run checkpoint)", () => {
        const markdown = renderMarkdown(
            payloadBuilder({
                state: "running",
                prNumber: 42,
                tests: { assigned: 39, passed: 0, failed: 0 },
            }),
        );

        expect(markdown).toContain("**Tests** `39`");
        // No pass/fail data and no duration -> those fields are dropped, never rendered as a bare "-".
        expect(markdown).not.toContain("**Pass rate**");
        expect(markdown).not.toContain("**Duration**");
        expect(markdown).not.toContain("`0%`");
    });

    it("labels the unresolved bucket as awaiting review when the job says so", () => {
        const markdown = renderMarkdown(
            payloadBuilder({
                state: "running",
                prNumber: 42,
                tests: { assigned: 39, passed: 0, failed: 0, running: 7, runningLabel: "awaiting review" },
            }),
        );

        expect(markdown).toContain("**Awaiting review** `7`");
        expect(markdown).not.toContain("**Running** `7`");
    });

    it("surfaces setup-failed tests as their own stat", () => {
        const markdown = renderMarkdown(
            payloadBuilder({
                state: "critical",
                prNumber: 42,
                tests: { assigned: 5, passed: 1, failed: 1, setupFailed: 2 },
            }),
        );

        expect(markdown).toContain("**Setup failed** `2`");
        expect(markdown).toContain("**Failed** `1`");
        expect(markdown).toContain("**Passed** `1`");
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

    it("renders the Evidence disclosure summary in bold, never as an image", () => {
        const markdown = renderMarkdown(
            payloadBuilder({
                state: "critical",
                prNumber: 42,
                assetBaseUrl: "https://cdn.autonoma.app/github-comment/",
                bugs: [
                    {
                        title: "Checkout button is hidden",
                        href: "https://autonoma.app/bug/1",
                        evidence: [
                            { source: "diff", detail: "removed the button", file: "src/checkout.tsx", lines: "10-12" },
                        ],
                    },
                ],
            }),
        );

        // Bold text, not an <img> chip: an image summary hijacks the click to open the image instead of
        // toggling the <details>.
        expect(markdown).toContain("<summary><strong>Evidence</strong></summary>");
        expect(markdown).not.toContain("evidence-chip");
    });

    it("renders the coding-agent handoff: deep-links plus a copy-paste prompt in a code fence", () => {
        const markdown = renderMarkdown({
            ...payloadBuilder({ state: "critical", prNumber: 42 }),
            handoff: {
                prompt: "Fix the bug.\n```\n- old\n+ new\n```",
                links: [
                    { label: "Open in Claude Code", href: "https://claude.ai/code?prompt=x&repositories=acme%2Fweb" },
                    { label: "Open in ChatGPT", href: "https://chatgpt.com/?q=x" },
                ],
            },
        });

        expect(markdown).toContain("<summary>🤖 Hand off to a coding agent</summary>");
        // Deep-links render as plain markdown links joined by " · ".
        expect(markdown).toContain(
            "[Open in Claude Code](<https://claude.ai/code?prompt=x&repositories=acme%2Fweb>) · [Open in ChatGPT](<https://chatgpt.com/?q=x>)",
        );
        // The prompt sits in a fence one backtick longer than the nested ``` block, so its code survives intact.
        expect(markdown).toContain("````\nFix the bug.\n```\n- old\n+ new\n```\n````");
    });
});
