import { db } from "@autonoma/db";
import { BugMatcher, openModelSession } from "@autonoma/diffs";
import { logger as rootLogger } from "@autonoma/logger";
import { TestSuiteUpdater } from "@autonoma/test-updates";
import type { ApplyHealingActionsInput, ApplyHealingActionsOutput } from "@autonoma/workflow/activities";
import { applyAddTest } from "./apply-add-test";
import { applyRemoveTest } from "./apply-remove-test";
import { applyReportBug } from "./apply-report-bug";
import { applyReportEngineLimitation } from "./apply-report-engine-limitation";
import { applyUpdatePlan } from "./apply-update-plan";

/**
 * Applies a batch of healing actions sequentially against the snapshot, then
 * - if any action created or changed a plan - opens iteration N+1 with the new
 * plan ids as its analysis scope.
 *
 * Sequencing matters: every action mutates the same snapshot, so applying them
 * in parallel would create lost-update races on TestCaseAssignment / TestPlan.
 * The transactional iter-N+1 setup at the end of the function makes iter N+1
 * either fully visible to subsequent activities or not at all.
 *
 * Per-action bug dedup: each report_bug action calls BugMatcher.findMatch
 * against the application's existing Bug rows before applyReportBug runs.
 * Because applyReportBug writes synchronously inside the loop, same-batch
 * siblings with the same root cause are matched against the freshly persisted
 * Bug on subsequent iterations, so duplicates should never reach the database.
 */
export async function applyHealingActions(input: ApplyHealingActionsInput): Promise<ApplyHealingActionsOutput> {
    const logger = rootLogger.child({
        name: "applyHealingActions",
        snapshotId: input.snapshotId,
        iterationId: input.currentIterationId,
        iteration: input.currentIterationNumber,
        count: input.actions.length,
    });
    logger.info("Applying healing actions");

    const matcher = await buildBugMatcher(input);

    const nextIterationPlanIds: string[] = [];

    for (const { action, refinementActionId } of input.actions) {
        switch (action.kind) {
            case "update_plan": {
                const { planId } = await applyUpdatePlan({
                    refinementActionId,
                    snapshotId: input.snapshotId,
                    organizationId: input.organizationId,
                    testCaseId: action.testCaseId,
                    newPrompt: action.newPrompt,
                });
                nextIterationPlanIds.push(planId);
                break;
            }
            case "add_test": {
                const { planId } = await applyAddTest({
                    refinementActionId,
                    snapshotId: input.snapshotId,
                    organizationId: input.organizationId,
                    folderId: action.folderId,
                    name: action.name,
                    instruction: action.instruction,
                    scenarioId: action.scenarioId,
                });
                nextIterationPlanIds.push(planId);
                break;
            }
            case "report_bug": {
                if (matcher == null) throw new Error("matcher should be defined when a report_bug action exists");
                const matchedBugId = await matcher.findMatch({
                    title: action.title,
                    description: action.description,
                });
                await applyReportBug({
                    refinementActionId,
                    snapshotId: input.snapshotId,
                    organizationId: input.organizationId,
                    testCaseId: action.testCaseId,
                    title: action.title,
                    description: action.description,
                    severity: action.severity,
                    evidence: action.evidence,
                    matchedBugId,
                    reviewLink: action.reviewLink,
                });
                break;
            }
            case "report_engine_limitation":
                await applyReportEngineLimitation({
                    refinementActionId,
                    snapshotId: input.snapshotId,
                    organizationId: input.organizationId,
                    testCaseId: action.testCaseId,
                    title: action.title,
                    description: action.description,
                    severity: action.severity,
                    evidence: action.evidence,
                    reviewLink: action.reviewLink,
                });
                break;
            case "remove_test":
                await applyRemoveTest({
                    refinementActionId,
                    snapshotId: input.snapshotId,
                    testCaseId: action.testCaseId,
                });
                break;
        }
    }

    if (nextIterationPlanIds.length === 0) {
        logger.info("No plan-changing actions; loop will converge after this iteration");
        return { nextIterationPlanIds: [] };
    }

    const nextIteration = await db.$transaction(async (tx) => {
        const current = await tx.refinementIteration.findUniqueOrThrow({
            where: { id: input.currentIterationId },
            select: { loopId: true },
        });

        const created = await tx.refinementIteration.create({
            data: {
                loopId: current.loopId,
                number: input.currentIterationNumber + 1,
                status: "pending",
            },
            select: { id: true },
        });

        await tx.refinementIterationInput.createMany({
            data: nextIterationPlanIds.map((planId) => ({ iterationId: created.id, planId })),
            skipDuplicates: true,
        });

        return created;
    });

    logger.info("Healing actions applied; next iteration scheduled", {
        nextIterationId: nextIteration.id,
        nextIterationPlanCount: nextIterationPlanIds.length,
    });

    return { nextIterationId: nextIteration.id, nextIterationPlanIds };
}

async function buildBugMatcher(input: ApplyHealingActionsInput): Promise<BugMatcher | undefined> {
    const hasReportBug = input.actions.some(({ action }) => action.kind === "report_bug");
    if (!hasReportBug) return undefined;

    const updater = await TestSuiteUpdater.continueUpdateBySnapshot({
        db,
        snapshotId: input.snapshotId,
        organizationId: input.organizationId,
    });

    const session = openModelSession();
    const model = session.getModel({ model: "smart-visual", tag: "bug-matcher" });
    return new BugMatcher(db, updater.applicationId, model);
}
