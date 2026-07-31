import type { AnalysisRunOutcome } from "@autonoma/types";
import { CancellationScope, executeChild, log, proxyActivities } from "@temporalio/workflow";
import type {
    AnalysisActivities,
    AnalysisCandidateFinding,
    AnalysisInvestigationTarget,
    InvestigatorActivities,
} from "../activities";
import { rootFailureMessage } from "../root-failure-message";
import { TaskQueue } from "../task-queues";
import { CONTAINMENT_CLASSIFICATION_NUMBER } from "./investigator.workflow";
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

// The parent proxies one Investigator activity: `persistAnalysisClassification`, to contain a child that crashed
// before it could file its own.
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
 * Reporter -> terminal settlement. When an org has it enabled it IS that org's PR-analysis pipeline, replacing the diffs
 * job: Impact Analysis selects + materializes the diff-affected/proposed tests on the branch's real pending
 * snapshot, one Investigator per test runs + classifies + self-heals it and persists its OWN finding, the Reporter
 * reconciles those findings into branch-scoped issues + authors the report (verdict, counts, prose), and the one
 * uncancellable settlement activity promotes or closes the snapshot and runs the terminal GitHub effects.
 */
export async function analysisWorkflow(input: AnalysisWorkflowInput): Promise<void> {
    const { snapshotId } = input;
    const ids = { snapshot: { snapshotId } };
    log.info("Analysis pipeline started", ids);

    let outcome: AnalysisRunOutcome = { kind: "succeeded" };
    let rethrowFailure: (() => never) | undefined;
    try {
        // Stage 0 - open the merge gate: for the auto-run-on-ready path (which reaches here without the API's
        // `requestAnalysisRun`), flip the un-requested `Autonoma` check to the in-progress "Analyzing" state and
        // stamp the activation.
        await analysis.openMergeGate({ snapshotId });

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
    } catch (error) {
        rethrowFailure = () => {
            throw error;
        };
        const reason = rootFailureMessage(error);
        outcome = { kind: "failed", reason };
        log.error("Analysis pipeline failed", { ...ids, extra: { failureReason: reason } });
    }

    const settled = await CancellationScope.nonCancellable(() => analysis.settleAnalysisRun({ snapshotId, outcome }));
    log.info("Analysis pipeline settled", { ...ids, extra: settled });

    if (rethrowFailure != null) rethrowFailure();
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
