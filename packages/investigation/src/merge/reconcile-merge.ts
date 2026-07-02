import { logger as rootLogger } from "@autonoma/logger";
import { type LanguageModel, Output, generateText } from "ai";
import { withRetry } from "../retry";
import type { BranchEdit, MainSuiteEntry, MergeInputs, RecipeMergeEdit } from "./merge-inputs";
import {
    buildMergePrompt,
    buildRecipeMergePrompt,
    MERGE_RECONCILER_SYSTEM_PROMPT,
    RECIPE_MERGE_RECONCILER_SYSTEM_PROMPT,
    renderEdit,
    renderMainSuite,
} from "./prompt";
import {
    MergePlanForModel,
    type MergePlan,
    type RecipeMergeDecision,
    RecipeMergePlanForModel,
    toMergeDecisions,
    toRecipeMergeDecisions,
} from "./schema";

// A single structured pass over a handful of edits - no tool loop - so a tight window is plenty and a slow
// call means an overloaded provider, not progress worth waiting on.
const RECONCILE_TIMEOUT_MS = 3 * 60_000;

// Cap the prompt so a PR that touched many tests (each modification carries THREE full plans) can never blow
// the model's context window or the reconcile timeout. ~300k chars ≈ 75k input tokens - safe headroom under
// gpt-5.5's window, with room for the output. Edits are packed into batches under this budget; the shared main
// catalog is resent per batch (each batch needs it to spot existing coverage), so it is excluded from the cap.
const MAX_EDIT_CHARS_PER_BATCH = 300_000;

// How many edit batches reconcile at once. Multi-batch merges are rare (only very large PRs), so a modest cap
// speeds them up without hammering the model's rate limit or spiking concurrent cost. Order is still preserved.
const RECONCILE_CONCURRENCY = 4;

export interface ReconcileMergeDeps {
    /** The model that produces the merge plan (the investigation classifier model). */
    model: LanguageModel;
}

/**
 * Split edits into batches whose rendered size stays under the per-batch budget, so no single reconcile prompt
 * can grow unbounded with the number (or size) of edits. Each edit always lands in some batch - an edit larger
 * than the whole budget still goes out alone rather than being dropped.
 */
function batchEdits(edits: BranchEdit[]): BranchEdit[][] {
    const batches: BranchEdit[][] = [];
    let current: BranchEdit[] = [];
    let currentChars = 0;
    for (const edit of edits) {
        const editChars = renderEdit(edit, 0).length;
        if (current.length > 0 && currentChars + editChars > MAX_EDIT_CHARS_PER_BATCH) {
            batches.push(current);
            current = [];
            currentChars = 0;
        }
        current.push(edit);
        currentChars += editChars;
    }
    if (current.length > 0) batches.push(current);
    return batches;
}

async function reconcileBatch(
    edits: BranchEdit[],
    mainSuite: MainSuiteEntry[],
    deps: ReconcileMergeDeps,
): Promise<MergePlan> {
    const result = await withRetry(
        () =>
            generateText({
                model: deps.model,
                system: MERGE_RECONCILER_SYSTEM_PROMPT,
                output: Output.object({ schema: MergePlanForModel }),
                prompt: buildMergePrompt(edits, mainSuite),
                abortSignal: AbortSignal.timeout(RECONCILE_TIMEOUT_MS),
            }),
        { label: "merge-reconcile", tries: 2 },
    );
    return { decisions: toMergeDecisions(result.output), recipeDecisions: [] };
}

/**
 * Reconcile the branch's scenario-recipe edits in one structured pass (recipe edits are few - one per scenario
 * a repair touched - so no batching is needed). Each decision is apply / apply-with-merged-graph / skip against
 * main's current recipe. A failure is contained (recipe edits drop from this merge and re-propose next run).
 */
async function reconcileRecipes(
    recipeEdits: RecipeMergeEdit[],
    deps: ReconcileMergeDeps,
): Promise<RecipeMergeDecision[]> {
    const logger = rootLogger.child({ name: "reconcileRecipes" });
    try {
        const result = await withRetry(
            () =>
                generateText({
                    model: deps.model,
                    system: RECIPE_MERGE_RECONCILER_SYSTEM_PROMPT,
                    output: Output.object({ schema: RecipeMergePlanForModel }),
                    prompt: buildRecipeMergePrompt(recipeEdits),
                    abortSignal: AbortSignal.timeout(RECONCILE_TIMEOUT_MS),
                }),
            { label: "recipe-merge-reconcile", tries: 2 },
        );
        return toRecipeMergeDecisions(result.output);
    } catch (error) {
        logger.warn("Recipe reconcile failed; dropping recipe edits from this merge", {
            extra: { recipeEdits: recipeEdits.length, error: String(error) },
        });
        return [];
    }
}

/**
 * Reconcile a branch's investigation edits into main's current suite: for each edit, decide apply /
 * apply-with-merged-plan / skip. Returns an empty plan without calling the model when there is nothing to
 * reconcile. When many/large edits would overflow one prompt, they are reconciled in batches (each with the
 * full main catalog for coverage detection), run with bounded concurrency, and the decisions concatenated in
 * batch order - so the prompt size is bounded regardless of how many tests the PR touched. A single batch that
 * fails is contained (its edits are dropped from this merge and re-proposed on the next run), never sinking the
 * rest.
 */
export async function reconcileMerge(inputs: MergeInputs, deps: ReconcileMergeDeps): Promise<MergePlan> {
    const logger = rootLogger.child({ name: "reconcileMerge" });
    if (inputs.edits.length === 0 && inputs.recipeEdits.length === 0) {
        logger.info("No branch edits or recipe edits to reconcile; returning empty plan");
        return { decisions: [], recipeDecisions: [] };
    }

    // Recipe edits reconcile in their own pass, independent of the test-edit batching below.
    const recipeDecisions = inputs.recipeEdits.length > 0 ? await reconcileRecipes(inputs.recipeEdits, deps) : [];

    if (inputs.edits.length === 0) {
        logger.info("Only recipe edits to reconcile", {
            extra: { recipeApplied: recipeDecisions.filter((decision) => decision.action === "apply").length },
        });
        return { decisions: [], recipeDecisions };
    }

    const batches = batchEdits(inputs.edits);
    logger.info("Reconciling branch edits into main", {
        extra: {
            edits: inputs.edits.length,
            mainSuiteSize: inputs.mainSuite.length,
            catalogChars: renderMainSuite(inputs.mainSuite).length,
            batches: batches.length,
        },
    });

    // Reconcile batches in bounded-concurrency waves. Promise.all preserves position within a wave and waves
    // run in order, so concatenating in iteration order keeps decisions in the original edit order.
    const decisions: MergePlan["decisions"] = [];
    for (let offset = 0; offset < batches.length; offset += RECONCILE_CONCURRENCY) {
        const wave = batches.slice(offset, offset + RECONCILE_CONCURRENCY);
        const settled = await Promise.all(
            wave.map(async (batch, index): Promise<MergePlan> => {
                const batchNumber = offset + index + 1;
                if (batches.length > 1) {
                    logger.info("Reconciling edit batch", {
                        extra: { batch: batchNumber, of: batches.length, edits: batch.length },
                    });
                }
                try {
                    return await reconcileBatch(batch, inputs.mainSuite, deps);
                } catch (error) {
                    logger.warn("Reconcile batch failed; dropping its edits from this merge", {
                        extra: { batch: batchNumber, edits: batch.length, error: String(error) },
                    });
                    return { decisions: [], recipeDecisions: [] };
                }
            }),
        );
        for (const plan of settled) decisions.push(...plan.decisions);
    }

    logger.info("Merge reconciled", {
        extra: {
            applied: decisions.filter((decision) => decision.action === "apply").length,
            skipped: decisions.filter((decision) => decision.action === "skip").length,
            recipeApplied: recipeDecisions.filter((decision) => decision.action === "apply").length,
            recipeSkipped: recipeDecisions.filter((decision) => decision.action === "skip").length,
        },
    });
    return { decisions, recipeDecisions };
}
