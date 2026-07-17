import type { AnalysisMode } from "@autonoma/types";
import { executeChild, log, proxyActivities } from "@temporalio/workflow";
import type { AnalysisActivities, AnalysisCandidateFinding, AnalysisInvestigationTarget } from "../activities";
import { rootFailureMessage } from "../root-failure-message";
import { TaskQueue } from "../task-queues";
import { WORKFLOW_TYPE } from "./workflow-types";

/**
 * How many Investigators run at once. Bounds concurrent browser sessions + scenario provisions against the
 * client preview; Temporal queues the excess. Matches the shadow investigation's fan-out cap.
 */
const INVESTIGATOR_CONCURRENCY = 10;

const analysis = proxyActivities<AnalysisActivities>({
    startToCloseTimeout: "20m",
    heartbeatTimeout: "2m",
    retry: { maximumAttempts: 1 },
    taskQueue: TaskQueue.DIFFS,
});

export interface AnalysisWorkflowInput {
    /** The detached twin snapshot the pipeline operates on (never wired to a branch pointer). */
    snapshotId: string;
    mode: AnalysisMode;
}

/**
 * The merged analysis pipeline (parent workflow): Impact Analysis -> Investigators (parallel fan-out) ->
 * Reconciler -> finalize. It replaces the overlapping `diffs` + `investigation` subsystems.
 *
 * This is the tracer-bullet slice: Impact Analysis selects the diff-affected tests, one Investigator per test
 * runs + classifies it (passed | client_bug; no re-run, no plan fix), and the Reconciler persists the verdict +
 * findings to the shadow store. In `shadow` mode it stays inert to production - it operates on a detached twin,
 * never promotes it, and files no user-facing rows; it only observes (the shadow store + a DeployedComparison
 * against the authoritative diffs output). `authoritative` mode (promotion + real filing) stays dormant until
 * the cutover ships.
 */
export async function analysisWorkflow(input: AnalysisWorkflowInput): Promise<void> {
    const { snapshotId, mode } = input;
    const ids = { snapshot: { snapshotId } };
    log.info("Analysis pipeline started", { ...ids, extra: { mode } });

    // Stage 1 - Impact Analysis: select the diff-affected tests to investigate.
    const impact = await analysis.runImpactAnalysis({ snapshotId, mode });
    log.info("Impact Analysis complete", { ...ids, extra: { targetCount: impact.targets.length } });

    // Stage 2 - Investigators: one child workflow per target, fanned out under a bounded concurrency budget.
    const candidates = await runInvestigators(snapshotId, mode, impact.targets, ids);
    log.info("Investigators complete", { ...ids, extra: { candidateCount: candidates.length } });

    // Stage 3 - Reconciler: holistic dedup + persist the shadow verdict + deduped findings; (authoritative only)
    // file bugs. Always produces the DeployedComparison against the diffs job.
    const reconciliation = await analysis.reconcileAnalysis({ snapshotId, mode, candidates });
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
            filedCount: reconciliation.filedCount,
            comparisonFound: reconciliation.comparison.found,
        },
    });

    // Stage 4 - finalize: workflow plumbing; promotes only in authoritative mode (no-op in shadow).
    const finalized = await analysis.finalizeAnalysis({ snapshotId, mode });
    log.info("Analysis pipeline completed", { ...ids, extra: { mode, promoted: finalized.promoted } });
}

/**
 * Fan out one Investigator child workflow per target, in bounded waves - the single choke point that holds the
 * ceiling on concurrent browsers / scenario provisions. Every target yields exactly one candidate finding: the
 * Investigator always returns one, and a child that crashed or timed out is contained here as an engine_artifact
 * (see runInvestigator), so no target is ever silently dropped and none can block the rendezvous.
 */
async function runInvestigators(
    snapshotId: string,
    mode: AnalysisMode,
    targets: AnalysisInvestigationTarget[],
    ids: { snapshot: { snapshotId: string } },
): Promise<AnalysisCandidateFinding[]> {
    const candidates: AnalysisCandidateFinding[] = [];
    for (let offset = 0; offset < targets.length; offset += INVESTIGATOR_CONCURRENCY) {
        const wave = targets.slice(offset, offset + INVESTIGATOR_CONCURRENCY);
        const waveCandidates = await Promise.all(wave.map((target) => runInvestigator(snapshotId, mode, target, ids)));
        candidates.push(...waveCandidates);
    }
    return candidates;
}

/**
 * Run one Investigator child workflow. The child id is keyed to the twin + slug so it is idempotent. Per-test
 * containment: a child that fails to execute (crash, cancellation, timeout) is caught and yields a contained
 * `engine_artifact` finding rather than sinking the whole fan-out - the shadow run must always proceed to a
 * verdict, and an engine fault never counts as a bug against the PR nor blocks the Reconciler barrier.
 */
async function runInvestigator(
    snapshotId: string,
    mode: AnalysisMode,
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
                    mode,
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
