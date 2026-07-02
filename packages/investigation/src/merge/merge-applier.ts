import type { PrismaClient } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { createDetachedSnapshot } from "@autonoma/test-updates";
import {
    EditPersister,
    type NewTestProposal,
    type PersistEditsResult,
    type TestModification,
} from "../persist/edit-persister";
import type { BranchEdit, RecipeMergeEdit } from "./merge-inputs";
import type { MergePlan } from "./schema";

export interface MergeApplyResult {
    /**
     * The detached snapshot cloned from main's active suite with the accepted edits applied - investigation's
     * PROPOSED main suite. Never wired to the main branch pointer, so the real (diffs) suite is untouched.
     * Undefined when nothing was accepted (no snapshot is created for an empty merge).
     */
    mainProposalSnapshotId?: string;
    persist?: PersistEditsResult;
    appliedCount: number;
    skippedCount: number;
    /** How many recipe decisions were written onto the proposal snapshot's recipe versions. */
    recipeAppliedCount: number;
    /** How many recipe decisions were dropped (skip, or no recipe version on the proposal to update). */
    recipeSkippedCount: number;
}

/**
 * Applies a reconciled merge plan onto a FRESH detached snapshot cloned from main's current active suite. The
 * accepted decisions become modifications / new tests on that snapshot via the shared `EditPersister`;
 * skipped decisions are dropped (their reasons live in the plan for the report). Cloning from main each merge
 * is what makes this self-healing - it always reconciles against ground-truth main, never a drifting copy.
 */
export class MergeApplier {
    private readonly logger: Logger;

    constructor(private readonly db: PrismaClient) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    async apply(
        edits: BranchEdit[],
        recipeEdits: RecipeMergeEdit[],
        plan: MergePlan,
        mainBranchId: string,
        organizationId: string,
    ): Promise<MergeApplyResult> {
        const editByKey = new Map(edits.map((edit) => [`${edit.kind}:${edit.ref}`, edit]));
        const recipeByScenario = new Map(recipeEdits.map((edit) => [edit.scenarioId, edit]));
        const accepted = plan.decisions.filter((decision) => decision.action === "apply");
        const acceptedRecipes = plan.recipeDecisions.filter((decision) => decision.action === "apply");
        const skippedCount = plan.decisions.length - accepted.length;
        const recipeSkippedFromPlan = plan.recipeDecisions.length - acceptedRecipes.length;

        this.logger.info("Applying merge plan to a detached main snapshot", {
            extra: {
                accepted: accepted.length,
                skipped: skippedCount,
                recipesAccepted: acceptedRecipes.length,
                mainBranchId,
            },
        });

        const modifications: TestModification[] = [];
        const newTests: NewTestProposal[] = [];
        for (const decision of accepted) {
            const edit = editByKey.get(`${decision.kind}:${decision.ref}`);
            if (edit == null) {
                this.logger.warn("Accepted decision has no matching edit; skipping", {
                    extra: { kind: decision.kind, ref: decision.ref },
                });
                continue;
            }
            const planText = decision.mergedPlan ?? edit.proposedPlan;
            if (decision.kind === "modification") {
                modifications.push({ slug: edit.ref, plan: planText });
            } else {
                newTests.push({ name: edit.name, description: edit.description, plan: planText });
            }
        }

        const hasTestEdits = modifications.length > 0 || newTests.length > 0;
        if (!hasTestEdits && acceptedRecipes.length === 0) {
            this.logger.info("No accepted test or recipe edits to apply; skipping main proposal snapshot");
            return { appliedCount: 0, skippedCount, recipeAppliedCount: 0, recipeSkippedCount: recipeSkippedFromPlan };
        }

        const created = await createDetachedSnapshot({ db: this.db, branchId: mainBranchId, organizationId });
        if (created == null) {
            this.logger.warn("Main branch has no baseline suite to fork; cannot apply merge plan", {
                extra: { mainBranchId },
            });
            return { appliedCount: 0, skippedCount, recipeAppliedCount: 0, recipeSkippedCount: recipeSkippedFromPlan };
        }

        const persist = hasTestEdits
            ? await new EditPersister(this.db).persist(created.snapshotId, organizationId, modifications, newTests)
            : undefined;

        // Write accepted recipe decisions onto the PROPOSAL snapshot's recipe versions (cloned from main by
        // createDetachedSnapshot) - never main's live active recipe. A scenario without a version on the proposal
        // (main has no recipe for it) is counted as skipped rather than created from nothing.
        let recipeAppliedCount = 0;
        for (const decision of acceptedRecipes) {
            const edit = recipeByScenario.get(decision.scenarioId);
            if (edit == null) {
                this.logger.warn("Accepted recipe decision has no matching edit; skipping", {
                    extra: { scenarioId: decision.scenarioId },
                });
                continue;
            }
            const applied = await this.writeRecipeOntoProposal(
                created.snapshotId,
                decision.scenarioId,
                decision.mergedCreateGraph ?? edit.proposedCreateGraph,
            );
            if (applied) recipeAppliedCount += 1;
        }
        const recipeSkippedCount = recipeSkippedFromPlan + (acceptedRecipes.length - recipeAppliedCount);

        this.logger.info("Merge plan applied to main proposal snapshot", {
            snapshot: { snapshotId: created.snapshotId },
            extra: {
                persisted: persist?.persisted.length ?? 0,
                skipped: persist?.skipped.length ?? 0,
                recipeApplied: recipeAppliedCount,
            },
        });
        return {
            mainProposalSnapshotId: created.snapshotId,
            persist,
            appliedCount: persist?.persisted.length ?? 0,
            skippedCount,
            recipeAppliedCount,
            recipeSkippedCount,
        };
    }

    /**
     * Overwrite the `create` graph of the proposal snapshot's recipe version for one scenario, preserving the
     * rest of the recipe (name/description/variables/validation). Returns false when the proposal has no recipe
     * version for that scenario (main never had one) - there is nothing to update, so the caller counts a skip.
     */
    private async writeRecipeOntoProposal(
        proposalSnapshotId: string,
        scenarioId: string,
        createGraphJson: string,
    ): Promise<boolean> {
        const version = await this.db.scenarioRecipeVersion.findUnique({
            where: { scenarioId_snapshotId: { scenarioId, snapshotId: proposalSnapshotId } },
            select: { fixtureJson: true },
        });
        if (version == null) {
            this.logger.warn("Proposal snapshot has no recipe version for scenario; skipping recipe apply", {
                snapshot: { snapshotId: proposalSnapshotId },
                extra: { scenarioId },
            });
            return false;
        }
        const recipe = { ...version.fixtureJson, create: parseCreateGraph(createGraphJson) };
        await this.db.scenarioRecipeVersion.update({
            where: { scenarioId_snapshotId: { scenarioId, snapshotId: proposalSnapshotId } },
            data: { fixtureJson: recipe },
        });
        return true;
    }
}

/** The reconciled create graph arrives as a JSON string; validate it is an object before writing it into a recipe. */
function parseCreateGraph(createGraphJson: string): Record<string, unknown> {
    const parsed: unknown = JSON.parse(createGraphJson);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Reconciled create graph is not a JSON object");
    }
    return { ...parsed };
}
