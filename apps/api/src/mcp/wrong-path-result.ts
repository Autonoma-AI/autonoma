import type { OnboardingPreviewEnvironmentMode } from "@autonoma/db";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { errorResult } from "./tool-result";

/**
 * The refusal a path-specific tool returns when the app is on the other path.
 * Names the tool to use instead: an agent told only "not supported" tends to
 * retry with different arguments, whereas a redirect moves it onto the right
 * playbook. Phrased from `requires` rather than fixed, since the check runs in
 * both directions - config/deploy/env tools refuse on the customer's own
 * pipeline, and the signal/Vercel tools refuse on Autonoma-hosted previews.
 */
export function wrongPathResult(
    tool: string,
    requires: OnboardingPreviewEnvironmentMode,
    useInstead: string,
): CallToolResult {
    const explanation =
        requires === "previewkit"
            ? `${tool} only applies to Autonoma-hosted previews. This app builds its previews on its own pipeline, so ` +
              "there is no Autonoma-side config, deploy or build log here."
            : `${tool} only applies to previews the project builds itself. Autonoma hosts this app's previews, so ` +
              "there is no external pipeline or Vercel project to connect.";
    return errorResult(`${explanation} Use ${useInstead} instead, and re-read the playbook that pair returned.`);
}
