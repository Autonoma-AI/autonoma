import type { AnalysisMode } from "@autonoma/types";
import { CancellationScope, log, proxyActivities } from "@temporalio/workflow";
import type {
    AnalysisCandidateFinding,
    GeneralActivities,
    InvestigationActivities,
    InvestigationVerdict,
    WebActivities,
} from "../activities";
import { rootFailureMessage } from "../root-failure-message";
import { TaskQueue } from "../task-queues";

const investigation = proxyActivities<InvestigationActivities>({
    startToCloseTimeout: "20m",
    heartbeatTimeout: "2m",
    retry: { maximumAttempts: 1 },
    taskQueue: TaskQueue.DIFFS,
});

const general = proxyActivities<GeneralActivities>({
    startToCloseTimeout: "10m",
    heartbeatTimeout: "2m",
    retry: { maximumAttempts: 1 },
    taskQueue: TaskQueue.GENERAL,
});

const web = proxyActivities<WebActivities>({
    startToCloseTimeout: "90m",
    heartbeatTimeout: "2m",
    retry: { maximumAttempts: 1 },
    taskQueue: TaskQueue.WEB,
});

export interface InvestigatorWorkflowInput {
    /** The detached twin snapshot the pipeline operates on. */
    snapshotId: string;
    /** The test this Investigator owns. */
    slug: string;
    /** The shadow generation to run for this test (created up front by Impact Analysis). */
    testGenerationId: string;
    /** The scenario to provision before the run, when the test pins one. */
    scenarioId?: string;
    /** Why the test was selected - passed to the classifier as context. */
    reason: string;
    mode: AnalysisMode;
}

/**
 * Investigator (child workflow, one per test): run the test's shadow generation on the web worker, classify the
 * outcome, and emit a candidate finding collapsed to `passed` | `client_bug`. It writes no rows and files no bugs
 * (the Reconciler owns the one cross-test write). This slice runs the test exactly ONCE - the self-heal re-run
 * loop, plan edits, and the full verdict taxonomy land in later slices. Returns `undefined` when the test could
 * not be evaluated (scenario provisioning failed, or the classifier produced no verdict), so the parent simply
 * drops it rather than counting a non-result.
 */
export async function investigatorWorkflow(
    input: InvestigatorWorkflowInput,
): Promise<AnalysisCandidateFinding | undefined> {
    const { snapshotId, slug, testGenerationId, scenarioId, reason, mode } = input;
    const ids = { snapshot: { snapshotId } };
    log.info("Investigator workflow started", { ...ids, extra: { slug, mode } });

    const verdict = await runAndClassify(snapshotId, slug, testGenerationId, scenarioId, reason);
    if (verdict == null) {
        log.info("Investigator produced no verdict; emitting no finding", { ...ids, extra: { slug } });
        return undefined;
    }

    // Collapse the classifier's verdict to the two categories this slice reports. Everything that is not a
    // confirmed client bug is `passed` here; the richer taxonomy arrives with the verdict slice.
    const category = verdict.isClientBug ? "client_bug" : "passed";
    log.info("Investigator workflow finished", { ...ids, extra: { slug, category } });
    return { slug, category, headline: verdict.headline };
}

/**
 * Provision the scenario (if the test pins one), run the shadow generation, and classify it. A failed browser run
 * is still classified - the failure IS the signal we want. Always tears the scenario down. Never throws: any
 * provisioning or classification failure returns `undefined` so a single test's fault stays contained to this
 * child and never fails the parent's fan-out.
 */
async function runAndClassify(
    snapshotId: string,
    slug: string,
    testGenerationId: string,
    scenarioId: string | undefined,
    reason: string,
): Promise<InvestigationVerdict | undefined> {
    let scenarioInstanceId: string | undefined;
    if (scenarioId != null) {
        try {
            const up = await general.scenarioUp({ entityId: testGenerationId, scenarioId });
            scenarioInstanceId = up.scenarioInstanceId;
        } catch (error) {
            log.warn("Scenario setup failed; the app was never exercised, so this test yields no finding", {
                snapshot: { snapshotId },
                extra: { slug, message: rootFailureMessage(error) },
            });
            return undefined;
        }
    }

    try {
        try {
            await web.runWebGeneration({ testGenerationId });
        } catch (error) {
            log.warn("Shadow generation errored; classifying the failed run anyway", {
                snapshot: { snapshotId },
                extra: { slug, message: rootFailureMessage(error) },
            });
        }
        const result = await investigation.classifyInvestigationRun({ snapshotId, slug, reason, testGenerationId });
        return result.verdict;
    } catch (error) {
        log.error("Classification failed; this test yields no finding", {
            snapshot: { snapshotId },
            extra: { slug, message: rootFailureMessage(error) },
        });
        return undefined;
    } finally {
        // Never let a teardown error escape - it would mask the verdict (or the undefined) this function just
        // resolved. Tear down outside cancellation so a superseded run still releases the scenario instance.
        if (scenarioInstanceId != null) {
            const instanceId = scenarioInstanceId;
            await CancellationScope.nonCancellable(() =>
                general.scenarioDown({ scenarioInstanceId: instanceId }),
            ).catch((error) => {
                log.warn("Scenario teardown failed after classify; keeping the result", {
                    snapshot: { snapshotId },
                    extra: { slug, message: rootFailureMessage(error) },
                });
            });
        }
    }
}
