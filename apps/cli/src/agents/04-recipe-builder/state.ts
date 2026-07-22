import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PermissionMode } from "./launcher";

export type EntityStatus = "pending" | "recipe-accepted" | "tested-up" | "tested-down" | "skipped";

export interface EntityProgress {
    entityName: string;
    status: EntityStatus;
    recipeData?: Record<string, unknown>[];
    errorLog: string[];
}

/**
 * Step-04 is a small state machine, each phase persisted so `--resume` continues
 * mid-flow. `tech-detect` seeds the entity order; the local agent implements the
 * integration, generates the recipe, and validates it entirely itself (`handoff`);
 * the CLI confirms the agent reported done (`completion`) and uploads the recipe
 * (`submit`). Interactive and `--non-interactive` runs take the same path - the
 * latter just drives the agent headlessly.
 */
export type RecipePhase = "tech-detect" | "handoff" | "completion" | "submit" | "done";

export interface RecipeBuilderState {
    phase: RecipePhase;
    entityOrder: string[];
    entities: Record<string, EntityProgress>;
    sharedSecret?: string;
    /** Which agent launcher the developer chose (e.g. "claude"); persisted so a
     *  `--resume` reuses it without re-detecting/re-prompting. */
    agentId?: string;
    /** The Claude permission mode the developer chose; persisted for `--resume`. */
    permissionMode?: PermissionMode;
    /** How many times the interactive agent has been launched for this handoff.
     *  Bounds the re-launch to finish an incomplete session. */
    launchAttempts?: number;
    /** Why a prior session didn't complete, carried into the re-launch so the agent
     *  resumes at the first unfinished item instead of redoing finished work. */
    priorFailure?: string;
    /** Path to the recipe the agent generates and validates against, then submitted. */
    recipePath?: string;
}

const STATE_FILE = ".recipe-builder-state.json";

export function initialRecipeState(): RecipeBuilderState {
    return {
        phase: "tech-detect",
        entityOrder: [],
        entities: {},
    };
}

export async function loadRecipeState(outputDir: string): Promise<RecipeBuilderState | undefined> {
    try {
        const raw = await readFile(join(outputDir, STATE_FILE), "utf-8");
        const parsed: RecipeBuilderState = JSON.parse(raw);
        return parsed;
    } catch {
        return undefined;
    }
}

export async function saveRecipeState(outputDir: string, state: RecipeBuilderState): Promise<void> {
    await writeFile(join(outputDir, STATE_FILE), JSON.stringify(state, null, 2), "utf-8");
}
