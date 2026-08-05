import { executeChild, log, proxyActivities } from "@temporalio/workflow";
import type { AnalysisCandidateFinding, AnalysisInvestigationTarget, InvestigatorActivities } from "../activities";
import { rootFailureMessage } from "../root-failure-message";
import { TaskQueue } from "../task-queues";
import { WORKFLOW_TYPE } from "../workflow-types";
import { CONTAINMENT_CLASSIFICATION_NUMBER } from "./investigator.workflow";

/**
 * How many Investigators run at once. Bounds concurrent browser sessions + scenario provisions against the
 * client preview; Temporal queues the excess.
 */
const INVESTIGATOR_CONCURRENCY = 10;

// The fan-out proxies one Investigator activity: `persistAnalysisClassification`, to contain a child that crashed
// before it could file its own.
const investigator = proxyActivities<InvestigatorActivities>({
    startToCloseTimeout: "20m",
    heartbeatTimeout: "2m",
    retry: { maximumAttempts: 1 },
    taskQueue: TaskQueue.DIFFS,
});

/**
 * Fan out one Investigator child workflow per target, in bounded waves - the single choke point that holds the
 * ceiling on concurrent browsers / scenario provisions. Every target yields exactly one persisted finding: the
 * Investigator persists its own, and a child that crashed or timed out is contained here as an engine_artifact
 * finding the caller persists (see {@link runInvestigator}), so no target is ever silently dropped.
 *
 * Shared by every parent that owns an analysis run - the analysis workflow for a customer-deployed preview and the
 * previewkit orchestrator for a preview we build ourselves - so the two can never drift on containment or
 * concurrency.
 */
export async function runInvestigators(
    snapshotId: string,
    targets: AnalysisInvestigationTarget[],
): Promise<AnalysisCandidateFinding[]> {
    const candidates: AnalysisCandidateFinding[] = [];
    for (let offset = 0; offset < targets.length; offset += INVESTIGATOR_CONCURRENCY) {
        const wave = targets.slice(offset, offset + INVESTIGATOR_CONCURRENCY);
        const waveCandidates = await Promise.all(wave.map((target) => runInvestigator(snapshotId, target)));
        candidates.push(...waveCandidates);
    }
    return candidates;
}

/**
 * Run one Investigator child workflow. The child id is keyed to the snapshot + slug so it is idempotent. The child
 * persists its own finding; per-test containment applies only when the child fails to execute (crash, cancellation,
 * timeout): the parent catches it, PERSISTS a contained `engine_artifact` finding in the child's place (the child
 * never reached its own persist), and returns it - so the run always proceeds to a verdict and an engine fault
 * never counts as a bug nor leaves a target with no finding. A persist failure of the containment finding is
 * logged and swallowed, never re-thrown - a single engine fault must not sink the whole fan-out.
 */
async function runInvestigator(
    snapshotId: string,
    target: AnalysisInvestigationTarget,
): Promise<AnalysisCandidateFinding> {
    const ids = { snapshot: { snapshotId } };
    log.info("Starting Investigator child workflow", { ...ids, extra: { slug: target.slug } });
    try {
        return await executeChild(WORKFLOW_TYPE.INVESTIGATOR, {
            workflowId: `investigator-${snapshotId}-${target.slug}`,
            taskQueue: TaskQueue.DIFFS,
            args: [
                {
                    snapshotId,
                    slug: target.slug,
                    testCaseId: target.testCaseId,
                    testGenerationId: target.testGenerationId,
                    scenarioId: target.scenarioId,
                    reason: target.reason,
                    origin: target.origin,
                },
            ],
        });
    } catch (error) {
        const message = rootFailureMessage(error);
        log.error("Investigator child workflow failed; containing it as an engine_artifact", {
            ...ids,
            extra: { slug: target.slug, message },
        });
        const headline = `The Investigator crashed or timed out: ${message}`;
        try {
            // Appended, never overwritten: whatever the child managed to classify stays on the finding as its own
            // history, and this fault becomes the verdict the run stands behind for the test. It takes a slot past
            // every iteration the child could have reached, so it can neither restate nor be restated by one.
            await investigator.persistAnalysisClassification({
                snapshotId,
                testCaseId: target.testCaseId,
                origin: target.origin,
                selectionReason: target.reason,
                number: CONTAINMENT_CLASSIFICATION_NUMBER,
                classification: {
                    // The child crashed, so it may have self-healed onto a later generation the parent never learns
                    // about. The one Impact Analysis queued is the run this containment can honestly point at.
                    generationId: target.testGenerationId,
                    category: "engine_artifact",
                    headline,
                },
            });
        } catch (persistError) {
            log.warn("Failed to persist the containment finding for a crashed Investigator", {
                ...ids,
                extra: { slug: target.slug, message: rootFailureMessage(persistError) },
            });
        }
        return {
            slug: target.slug,
            testCaseId: target.testCaseId,
            generationId: target.testGenerationId,
            category: "engine_artifact",
            headline,
            origin: target.origin,
        };
    }
}
