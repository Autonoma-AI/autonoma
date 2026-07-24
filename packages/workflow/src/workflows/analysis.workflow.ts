import { executeChild, log, proxyActivities } from "@temporalio/workflow";
import type {
    AnalysisActivities,
    AnalysisCandidateFinding,
    AnalysisInvestigationTarget,
    InvestigatorActivities,
} from "../activities";
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

// The parent proxies one Investigator activity: `persistAnalysisFinding`, to file the containment finding for a
// child that crashed before it could persist its own.
const investigator = proxyActivities<InvestigatorActivities>({
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
 * Reporter -> finalize. When an org has it enabled it IS that org's PR-analysis pipeline, replacing the diffs
 * job: Impact Analysis selects + materializes the diff-affected/proposed tests on the branch's real pending
 * snapshot, one Investigator per test runs + classifies + self-heals it and persists its OWN finding, the Reporter
 * reconciles those findings into branch-scoped issues + authors the report (verdict, counts, prose), and finalize
 * promotes the snapshot.
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
        // Each Investigator persists its OWN finding; the parent files containment findings for crashed children.
        const candidates = await runInvestigators(snapshotId, impact.targets, ids);
        log.info("Investigators complete", { ...ids, extra: { candidateCount: candidates.length } });

        // Stage 3 - Reporter: reconcile the persisted findings into branch-scoped issues + author the report
        // (verdict, counts, prose), carrying the Impact Analysis reasoning. A failure here fails the run via the
        // shared catch below; the findings persist regardless.
        const reporter = await analysis.runReporter({ snapshotId, impactReasoning: impact.reasoning });
        log.info("Reporter complete", {
            ...ids,
            extra: {
                verdict: reporter.verdict,
                clientBugCount: reporter.clientBugCount,
                issuesOpened: reporter.issuesOpened,
                issuesCarried: reporter.issuesCarried,
                issuesResolved: reporter.issuesResolved,
            },
        });

        // Stage 4 - finalize: promote the snapshot + mark the job completed.
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

        // Stage 6 - merge gate: map the verdict to the `Autonoma` check conclusion (flag-gated, per-org opt-in).
        try {
            const gate = await analysis.applyMergeGateVerdict({ snapshotId });
            log.info("Merge gate step finished", {
                ...ids,
                extra: { status: gate.status, conclusion: gate.conclusion },
            });
        } catch (gateError) {
            log.error("Merge gate step failed; run already completed, continuing", {
                ...ids,
                extra: { message: rootFailureMessage(gateError) },
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
 * ceiling on concurrent browsers / scenario provisions. Every target yields exactly one persisted finding: the
 * Investigator persists its own, and a child that crashed or timed out is contained here as an engine_artifact
 * finding the parent persists (see runInvestigator), so no target is ever silently dropped.
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
        const containment: AnalysisCandidateFinding = {
            slug: target.slug,
            category: "engine_artifact",
            headline: `The Investigator crashed or timed out: ${message}`,
            planEdited: false,
            origin: target.origin,
            selectionReason: target.reason,
        };
        try {
            await investigator.persistAnalysisFinding({ snapshotId, finding: containment });
        } catch (persistError) {
            log.warn("Failed to persist the containment finding for a crashed Investigator", {
                ...ids,
                extra: { slug: target.slug, message: rootFailureMessage(persistError) },
            });
        }
        return containment;
    }
}
