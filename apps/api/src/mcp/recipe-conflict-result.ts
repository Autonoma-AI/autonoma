import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { RecipeConflictError } from "../routes/scenarios/recipe-conflict-error";
import { jsonResult } from "./tool-result";

/** The `baseFingerprint` input shared by every tool that writes a recipe. */
export const baseFingerprintInput = z
    .string()
    .optional()
    .describe(
        "The `fingerprint` get_recipe returned for the recipe you edited. Always pass it: if someone " +
            "else changed the recipe in between, the write is rejected and you get their version back " +
            "instead of silently overwriting it. Omitting it makes your write unconditional.",
    );

/**
 * Render a rejected stale write as a RESULT rather than an error.
 *
 * An error string tells an agent it failed; this tells it how to succeed. The payload carries the
 * recipe that is stored now and the one the agent started from, so together with its own draft it
 * has the three inputs a merge needs and can reconcile and retry in the same turn. Returns
 * undefined for anything that is not a conflict, so callers fall through to normal error handling.
 */
export function recipeConflictResult(err: unknown): CallToolResult | undefined {
    if (!(err instanceof RecipeConflictError)) return undefined;

    return jsonResult({
        status: "conflict",
        message: err.message,
        guidance:
            "Someone else changed this recipe after you read it. Do NOT re-send your version as-is - that " +
            "would discard their change. Compare `base` (what you started from) with `current` (what is " +
            "stored now), apply your own edit on top of `current`, and call update_recipe again with " +
            "`baseFingerprint` set to `currentFingerprint`.",
        base: err.conflict.base,
        baseFingerprint: err.conflict.baseFingerprint,
        current: err.conflict.current,
        currentFingerprint: err.conflict.currentFingerprint,
        currentSource: err.conflict.currentSource,
        currentEditedAt: err.conflict.currentEditedAt,
    });
}
