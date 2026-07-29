import { createHash } from "node:crypto";

/**
 * Compute a deterministic SHA-256 fingerprint over a recipe payload.
 * Used to detect changes across uploads.
 */
export function hashRecipe(recipe: unknown): string {
    return createHash("sha256").update(JSON.stringify(recipe)).digest("hex");
}
