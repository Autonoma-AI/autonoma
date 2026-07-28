import type { ScenarioRecipe } from "@autonoma/types";

/** The three recipes a caller needs to reconcile a conflicting write, named from its point of view. */
export interface RecipeConflict {
    /** What is stored right now - someone else's write, which this one would have overwritten. */
    current: ScenarioRecipe | undefined;
    currentFingerprint: string;
    /** The revision the caller started from, recovered from history. Absent if it aged out of the log. */
    base: ScenarioRecipe | undefined;
    baseFingerprint: string;
    /** Who made the write that landed first, and when - so a human can be asked before clobbering it. */
    currentSource: string | undefined;
    currentEditedAt: Date | undefined;
}

/**
 * A write whose base is no longer what is stored: someone else changed the recipe in between.
 *
 * Carries the current recipe and the base the caller started from, because rejecting a stale write
 * is only half an answer - the caller (usually an agent) still has to produce a correct one. With
 * its own draft plus these two it has the same three inputs a three-way merge needs, and can
 * reconcile and retry instead of either giving up or blindly overwriting.
 */
export class RecipeConflictError extends Error {
    constructor(
        readonly scenarioId: string,
        readonly conflict: RecipeConflict,
    ) {
        super(
            `The recipe changed since you read it. Expected ${conflict.baseFingerprint.slice(0, 12)}, found ` +
                `${conflict.currentFingerprint.slice(0, 12)}` +
                (conflict.currentSource != null ? ` (written via ${conflict.currentSource})` : "") +
                `. Re-read it, merge your change into what is there now, and retry.`,
        );
        this.name = "RecipeConflictError";
    }
}
