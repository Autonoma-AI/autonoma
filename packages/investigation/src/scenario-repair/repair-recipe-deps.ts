import type { LanguageModel } from "ai";
import type { CodebaseReader, PreviewAccess } from "../classify/dependencies";

/** The outcome of seeding a candidate create graph against the deployed SDK, without running the test. */
export interface DryRunSeedResult {
    /** True iff the client's factory accepted the graph and the `up` returned valid auth/refs. */
    ok: boolean;
    /** A short human summary of what seeded (per-entity counts, auth returned) or why it failed. */
    detail: string;
}

/** Seed a candidate create graph against the deployed SDK (`up`), report the result, then tear it down. */
export type DryRunSeed = (createGraphJson: string) => Promise<DryRunSeedResult>;

/**
 * Everything the recipe-repair agent needs, injected so the loop is unit-testable with fakes and the worker wires
 * the real implementations (the cloned repo, the preview backend, the SDK, the model). The code/DB reach comes
 * from the same primitives the classifier uses (`CodebaseReader` for repo + schema, `PreviewAccess.runScript` for
 * querying the live backend); `dryRunSeed` is the recipe-specific capability that confirms the factory accepts a
 * candidate before we spend a twin rerun on it.
 */
export interface RepairRecipeDeps {
    codebase: CodebaseReader;
    preview: PreviewAccess;
    /** Optional: when absent (SDK config unavailable), the agent falls back to schema + backend queries. */
    dryRunSeed?: DryRunSeed;
    model: LanguageModel;
    /** Tool-call budget for the agent's investigation loop. */
    maxSteps: number;
}

/** A recipe already tried on an earlier outer-loop pass, and how the REAL test still failed with it on the twin. */
export interface PriorRepairAttempt {
    /** The `create` graph that was staged (JSON string). */
    createGraphJson: string;
    /** How the test failed on the twin with that recipe - what this attempt must do differently. */
    failureDetail: string;
}

/** The facts about the failure the agent is repairing (the diagnosis already chose the recipe route). */
export interface RepairRecipeInput {
    appSlug: string;
    prNumber: number;
    /** The failing test's slug. */
    slug: string;
    /** The scenario recipe's current `create` graph (the seed request), as a JSON string. */
    currentCreateGraph: string;
    /** The change the diagnoser said the recipe needs (prose). */
    recipeChange: string;
    /** The failure being repaired (the SDK error or the run's data-mismatch account). */
    failureDetail: string;
    /** The test plan the repaired recipe must satisfy. */
    testPlan: string;
    /**
     * Recipes tried on earlier passes that SEEDED but did not make the test pass on the twin. The agent must
     * diagnose WHY each failed and produce a materially different graph - re-adding the same data will fail again.
     */
    priorAttempts?: PriorRepairAttempt[];
}
