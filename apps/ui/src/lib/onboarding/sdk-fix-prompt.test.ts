import { MAX_HANDOFF_PROMPT_CHARS } from "@autonoma/types";
import { describe, expect, it } from "vitest";
import { buildSdkFixPrompt } from "./sdk-fix-prompt";

const BASE = {
    applicationId: "app_01hzk3",
    applicationName: "Acme Web",
    targetId: "pr-42",
    error: "SDK returned HTTP 404: Autonoma endpoint is disabled in production",
    sdkUrl: "https://acme-web-pr-42.preview.autonoma.app/api/autonoma",
    mcpUrl: "https://api.autonoma.app/v1/mcp",
    mcpServerName: "autonoma",
};

describe("buildSdkFixPrompt", () => {
    it("carries the failure and the endpoint verbatim, so the agent needs no login to read them", () => {
        const prompt = buildSdkFixPrompt(BASE);
        expect(prompt).toContain(BASE.error);
        expect(prompt).toContain(BASE.sdkUrl);
        expect(prompt).toContain("Acme Web");
    });

    it("names the MCP server literally, so an agent holding several can pick the right one", () => {
        const prompt = buildSdkFixPrompt(BASE);
        expect(prompt).toContain("`autonoma` MCP");
        expect(prompt).toContain(
            "claude mcp add --transport http --scope user autonoma https://api.autonoma.app/v1/mcp",
        );
    });

    it("spells out the arguments the MCP tools take, which accept no repo name", () => {
        const prompt = buildSdkFixPrompt(BASE);
        expect(prompt).toContain('validate_sdk(applicationId: "app_01hzk3", target: "pr-42")');
    });

    it("only offers get_target_logs for a preview Autonoma actually hosts", () => {
        // A Vercel / bring-your-own deployment: the tool refuses targets Autonoma does not operate.
        expect(buildSdkFixPrompt(BASE)).not.toContain("get_target_logs");

        const managed = buildSdkFixPrompt({ ...BASE, repoFullName: "acme/web" });
        expect(managed).toContain('get_target_logs(applicationId: "app_01hzk3", target: "pr-42", source: "app")');
    });

    it("explains a 404 as the production guard it usually is, not as a routing mistake", () => {
        const prompt = buildSdkFixPrompt(BASE);
        expect(prompt).toContain("What this failure usually means");
        expect(prompt).toContain("NODE_ENV");
        // The fix has to keep the endpoint off in real production, not just delete the guard.
        expect(prompt).toContain("do not simply remove the guard");
    });

    it("explains an auth rejection in terms of the two secrets and the raw-body HMAC", () => {
        const prompt = buildSdkFixPrompt({ ...BASE, error: "SDK returned HTTP 401: Invalid HMAC signature" });
        expect(prompt).toContain("re-serialized body");
        expect(prompt).toContain("AUTONOMA_SIGNING_SECRET");
    });

    it("says nothing about a likely cause when the status carries no known one", () => {
        const prompt = buildSdkFixPrompt({ ...BASE, error: "SDK discover response validation failed: models.0.name" });
        expect(prompt).not.toContain("What this failure usually means");
    });

    it("includes the target's location only when it is known", () => {
        expect(buildSdkFixPrompt(BASE)).not.toContain("Where it failed");

        const located = buildSdkFixPrompt({
            ...BASE,
            targetLabel: "feat: autonoma-sdk #42",
            previewUrl: "https://acme-web-pr-42.preview.autonoma.app",
            pullRequestUrl: "https://github.com/acme/web/pull/42",
        });
        expect(located).toContain("feat: autonoma-sdk #42");
        expect(located).toContain("https://github.com/acme/web/pull/42");
    });

    it("caps a runaway error rather than emitting an unbounded prompt", () => {
        const prompt = buildSdkFixPrompt({ ...BASE, error: "x".repeat(MAX_HANDOFF_PROMPT_CHARS * 2) });
        expect(prompt).toContain("(truncated)");
        expect(prompt.length).toBeLessThan(MAX_HANDOFF_PROMPT_CHARS + 500);
    });
});
