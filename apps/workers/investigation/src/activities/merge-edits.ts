import { db } from "@autonoma/db";
import { MergeApplier, MergeInputsReader, reconcileMerge } from "@autonoma/investigation";
import { logger as rootLogger } from "@autonoma/logger";
import type { MergeInvestigationEditsInput, MergeInvestigationEditsOutput } from "@autonoma/workflow/activities";
import { createModelSession } from "../services";

/**
 * Merge-with-main: reconcile the branch twin's proposed test edits into main's current suite and apply the
 * accepted ones onto a detached main-proposal snapshot. Reads both sides from the DB, runs ONE structured
 * reconcile pass (the classifier model), then applies via the shared EditPersister. Never touches main's real
 * (diffs) suite - the proposal snapshot is detached. A no-edit twin short-circuits before any model call.
 */
export async function mergeInvestigationEdits(
    input: MergeInvestigationEditsInput,
): Promise<MergeInvestigationEditsOutput> {
    const { twinSnapshotId, mainSnapshotId, mainBranchId, organizationId } = input;
    const logger = rootLogger.child({ name: "mergeInvestigationEdits", extra: { twinSnapshotId, mainSnapshotId } });
    logger.info("Merging investigation edits into main");

    const inputs = await new MergeInputsReader(db).read(twinSnapshotId, mainSnapshotId, organizationId);
    const session = createModelSession();
    const plan = await reconcileMerge(inputs, {
        model: session.getModel({ model: "classifier", tag: "investigation-merge" }),
    });

    const result = await new MergeApplier(db).apply(
        inputs.edits,
        inputs.recipeEdits,
        plan,
        mainBranchId,
        organizationId,
    );

    logger.info("Merged investigation edits into main", {
        extra: {
            applied: result.appliedCount,
            skipped: result.skippedCount,
            recipeApplied: result.recipeAppliedCount,
            recipeSkipped: result.recipeSkippedCount,
        },
    });
    return {
        mainProposalSnapshotId: result.mainProposalSnapshotId,
        appliedCount: result.appliedCount,
        skippedCount: result.skippedCount,
        recipeAppliedCount: result.recipeAppliedCount,
        recipeSkippedCount: result.recipeSkippedCount,
        decisions: plan.decisions.map((decision) => ({
            kind: decision.kind,
            ref: decision.ref,
            action: decision.action,
            reason: decision.reason,
        })),
        recipeDecisions: plan.recipeDecisions.map((decision) => ({
            scenarioId: decision.scenarioId,
            action: decision.action,
            reason: decision.reason,
        })),
    };
}
