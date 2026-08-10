import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ApplicationInstructionsConflictError } from "../routes/applications/application-instructions-conflict-error";
import { jsonResult } from "./tool-result";

/**
 * Render a rejected stale instructions write as a RESULT rather than an error.
 *
 * Same bargain as {@link recipeConflictResult}: an error string tells an agent it failed, this
 * tells it how to succeed. There is no `base` to hand back - instructions keep no version history -
 * so the agent reconciles from `current` plus the draft it already has. Returns undefined for
 * anything that is not a conflict, so callers fall through to normal error handling.
 */
export function instructionsConflictResult(err: unknown): CallToolResult | undefined {
    if (!(err instanceof ApplicationInstructionsConflictError)) return undefined;

    return jsonResult({
        status: "conflict",
        message: err.message,
        guidance:
            "Someone edited these instructions after you read them. Do NOT re-send your version as-is - that " +
            "would discard their words, and there is no history to restore them from. Apply your change on top " +
            "of `current`, then call update_app_instructions again with `baseFingerprint` set to " +
            "`currentFingerprint`.",
        current: err.conflict.current,
        currentFingerprint: err.conflict.currentFingerprint,
        baseFingerprint: err.conflict.baseFingerprint,
    });
}
