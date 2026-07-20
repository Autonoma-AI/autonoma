import { executeChild, log, proxyActivities } from "@temporalio/workflow";
import type { AnalysisActivities, AnalysisCandidateFinding, AnalysisInvestigationTarget } from "../activities";
import { rootFailureMessage } from "../root-failure-message";
import { TaskQueue } from "../task-queues";
import { WORKFLOW_TYPE } from "./workflow-types";

/**
 * How many Investigators run at once. Bounds concurrent browser sessions + scenario provisions against the
 * client preview; Temporal queues the excess.
 */
const INVESTIGATOR_CONCURRENCY = 10;

const analysis = proxyActivities<AnalysisActivities>({
    startToCloseTimeout: "20m",
    heartbeatTimeout: "2m",
    retry: { maximumAttempts: 1 },
    taskQueue: TaskQueue.DIFFS,
});

export interface AnalysisWorkflowInput {
    /** The branch's real pending snapshot the pipeline operates on. */
    snapshotId: string;
}

/**
 * The merged analysis pipeline (parent workflow): Impact Analysis -> Investigators (parallel fan-out) ->
 * Reconciler -> finalize. When an org has it enabled it IS that org's PR-analysis pipeline, replacing the diffs
 * job: Impact Analysis selects + materializes the diff-affected/proposed tests on the branch's real pending
 * snapshot, one Investigator per test runs + classifies + self-heals it, the Reconciler persists the report +
 * per-test findings (the single source of truth - no Bug/Issue is filed), and finalize promotes the snapshot.
 */
export async function analysisWorkflow(input: AnalysisWorkflowInput): Promise<void> {
    const { snapshotId } = input;
    const ids = { snapshot: { snapshotId } };
    log.info("Analysis pipeline started", ids);

    // The four stages share one catch so any failure finalizes the run's status rather than leaving it stuck:
    // finalize marks the AnalysisJob `failed` (mirroring how the diffs workflow finalizes its job on refinement
    // failure), then the error rethrows.
    try {
        // Stage 1 - Impact Analysis: select the diff-affected tests to investigate.
        const impact = await analysis.runImpactAnalysis({ snapshotId });
        log.info("Impact Analysis complete", { ...ids, extra: { targetCount: impact.targets.length } });

        // Stage 2 - Investigators: one child workflow per target, fanned out under a bounded concurrency budget.
        const candidates = await runInvestigators(snapshotId, impact.targets, ids);
        log.info("Investigators complete", { ...ids, extra: { candidateCount: candidates.length } });

        // Stage 3 - Reconciler: holistic dedup + persist the AnalysisReport + per-test findings (the single
        // source of truth; no Bug/Issue filed), carrying the Impact Analysis selection reasoning onto the report.
        const reconciliation = await analysis.reconcileAnalysis({
            snapshotId,
            candidates,
            impactReasoning: impact.reasoning,
        });
        log.info("Reconciler complete", {
            ...ids,
            extra: {
                verdict: reconciliation.verdict,
                findingCount: reconciliation.findingCount,
                clientBugCount: reconciliation.clientBugCount,
                coverageFindingCount: reconciliation.coverageFindingCount,
                unestablishedProposedCount: reconciliation.unestablishedProposedCount,
                obsoleteRemovedCount: reconciliation.obsoleteRemovedCount,
                narrated: reconciliation.narrated,
            },
        });

        // Stage 4 - finalize: promote the snapshot + mark the AnalysisJob completed.
        const finalized = await analysis.finalizeAnalysis({ snapshotId });
        log.info("Analysis pipeline completed", { ...ids, extra: { promoted: finalized.promoted } });

        // Stage 5 - PR comment: post/update the run's comment (flag-gated, idempotent). The report is already
        // persisted and the snapshot promoted, so a comment failure must NEVER fail the completed run - it is
        // caught here so it can never reach the outer catch, which would otherwise re-finalize the job as failed.
        try {
            const comment = await analysis.postAnalysisPrComment({ snapshotId });
            log.info("Analysis PR comment step finished", { ...ids, extra: { status: comment.status } });
        } catch (commentError) {
            log.error("Analysis PR comment failed; run already completed, continuing", {
                ...ids,
                extra: { message: rootFailureMessage(commentError) },
            });
        }
    } catch (error) {
        const failureReason = rootFailureMessage(error);
        log.error("Analysis pipeline failed; finalizing the run as failed", { ...ids, extra: { failureReason } });
        await analysis.finalizeAnalysis({ snapshotId, failureReason });
        throw error;
    }
}

/**
 * Fan out one Investigator child workflow per target, in bounded waves - the single choke point that holds the
 * ceiling on concurrent browsers / scenario provisions. Every target yields exactly one candidate finding: the
 * Investigator always returns one, and a child that crashed or timed out is contained here as an engine_artifact
 * (see runInvestigator), so no target is ever silently dropped and none can block the rendezvous.
 */
async function runInvestigators(
    snapshotId: string,
    targets: AnalysisInvestigationTarget[],
    ids: { snapshot: { snapshotId: string } },
): Promise<AnalysisCandidateFinding[]> {
    const candidates: AnalysisCandidateFinding[] = [];
    for (let offset = 0; offset < targets.length; offset += INVESTIGATOR_CONCURRENCY) {
        const wave = targets.slice(offset, offset + INVESTIGATOR_CONCURRENCY);
        const waveCandidates = await Promise.all(wave.map((target) => runInvestigator(snapshotId, target, ids)));
        candidates.push(...waveCandidates);
    }
    return candidates;
}

/**
 * Run one Investigator child workflow. The child id is keyed to the snapshot + slug so it is idempotent. Per-test
 * containment: a child that fails to execute (crash, cancellation, timeout) is caught and yields a contained
 * `engine_artifact` finding rather than sinking the whole fan-out - the run must always proceed to a verdict, and
 * an engine fault never counts as a bug against the PR nor blocks the Reconciler barrier.
 */
async function runInvestigator(
    snapshotId: string,
    target: AnalysisInvestigationTarget,
    ids: { snapshot: { snapshotId: string } },
): Promise<AnalysisCandidateFinding> {
    log.info("Starting Investigator child workflow", { ...ids, extra: { slug: target.slug } });
    try {
        return await executeChild(WORKFLOW_TYPE.INVESTIGATOR, {
            workflowId: `investigator-${snapshotId}-${target.slug}`,
            taskQueue: TaskQueue.DIFFS,
            args: [
                {
                    snapshotId,
                    slug: target.slug,
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
        return {
            slug: target.slug,
            category: "engine_artifact",
            headline: `The Investigator crashed or timed out: ${message}`,
            planEdited: false,
            origin: target.origin,
        };
    }
}
