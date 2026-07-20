import type { AnalysisFindingReport, AnalysisTestOrigin, AnalysisVerdict } from "@autonoma/types";
import { CancellationScope, log, proxyActivities } from "@temporalio/workflow";
import type {
    AnalysisCandidateFinding,
    GeneralActivities,
    InvestigationActivities,
    InvestigationTestResult,
    InvestigationVerdict,
    InvestigatorActivities,
    WebActivities,
} from "../activities";
import { rootFailureMessage } from "../root-failure-message";
import { categorizeInfraFailure } from "../scenario-setup-failure";
import { TaskQueue } from "../task-queues";

/**
 * Max run+classify passes for one test: the initial run plus, on a "test is wrong" verdict, a single self-heal
 * re-run of a rewritten plan. Bounded so the loop always terminates - the final pass never rewrites nor re-runs
 * (the plan-edit path is withheld), which is what guarantees termination and forces a still-wrong test to `delete`.
 */
const MAX_INVESTIGATOR_ITERATIONS = 2;

/**
 * The transient loop-routing bucket: the classifier said the APP rendered correctly but the TEST itself is wrong
 * (a stale plan, or a plan wrong by design - the old `outdated_test` + `bad_test`, collapsed). It is NEVER emitted
 * as a finding: it drives a self-heal plan rewrite + re-run, and when the loop exhausts on a healthy app it
 * resolves to the `delete` terminal.
 */
const TEST_IS_WRONG = "test_is_wrong" as const;

/**
 * The classifier's Category values that collapse to the transient `test_is_wrong` bucket. Coupled to the copied
 * classifier's `Category` enum (`@autonoma/diffs/analysis`): the workflow sandbox cannot import that package to
 * reference the enum by symbol, so we hardcode its two literals here. Both REQUIRE the app to have rendered -
 * which is why an exhausted loop on either one resolves to `delete` (a correct app whose test we could not
 * stabilize), never to a bug.
 */
const TEST_IS_WRONG_CATEGORIES = new Set(["outdated_test", "bad_test"]);

/** Reason recorded for a self-heal re-run, fed to the classifier as context for the follow-up pass. */
const SELF_HEAL_RERUN_REASON =
    "Re-running after a self-heal plan rewrite: the prior run indicated a stale/incorrect test on a healthy app.";

/** How much of a fault's underlying error message to carry into the finding headline (the rest is only logged). */
const FAULT_DETAIL_CAP = 200;

const investigation = proxyActivities<InvestigationActivities>({
    startToCloseTimeout: "20m",
    heartbeatTimeout: "2m",
    retry: { maximumAttempts: 1 },
    taskQueue: TaskQueue.DIFFS,
});

const investigator = proxyActivities<InvestigatorActivities>({
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
    /** The snapshot the pipeline operates on. */
    snapshotId: string;
    /** The test this Investigator owns. */
    slug: string;
    /** The generation to run for this test (created up front by Impact Analysis). */
    testGenerationId: string;
    /** The scenario to provision before the run, when the test pins one. */
    scenarioId?: string;
    /** Why the test was selected - passed to the classifier as context. */
    reason: string;
    /** Whether this test pre-existed (affected) or was authored this run (proposed). Rides onto the finding and
     * decides how a `delete` cleans up (assignment-only vs the whole TestCase). */
    origin: AnalysisTestOrigin;
}

/**
 * Investigator (child workflow, one per test): run the test's generation on the web worker, classify the
 * outcome, and emit ONE candidate finding across the full two-plane taxonomy. It writes no rows other than its
 * own test's (plan edit + eager self-delete) and files no bugs (the Reconciler owns the one cross-test write).
 *
 * When a run shows the TEST itself is wrong on a healthy app it self-heals: rewrite the plan on this test's own
 * rows and re-run, bounded by MAX_INVESTIGATOR_ITERATIONS. If that loop exhausts (the final iteration withholds
 * the re-run), the test is a correct-app test we cannot stabilize, so it resolves to `delete` and the Investigator
 * eagerly self-deletes its own row. It ALWAYS returns a finding - a scenario/classify fault is contained as a
 * coverage-plane verdict (environment_failure / scenario_issue / engine_artifact), never a silent drop.
 */
export async function investigatorWorkflow(input: InvestigatorWorkflowInput): Promise<AnalysisCandidateFinding> {
    const { snapshotId, slug, testGenerationId, scenarioId, reason, origin } = input;
    const ids = { snapshot: { snapshotId } };
    log.info("Investigator workflow started", { ...ids, extra: { slug, origin } });

    const finding = await runWithSelfHeal(snapshotId, slug, testGenerationId, scenarioId, reason, origin);
    log.info("Investigator workflow finished", {
        ...ids,
        extra: { slug, category: finding.category, planEdited: finding.planEdited, origin: finding.origin },
    });
    return finding;
}

/**
 * Run the test and route its verdict. A terminal verdict (client_bug / passed / engine_artifact /
 * environment_failure / scenario_issue) is returned immediately. A `test_is_wrong` verdict (healthy app, wrong
 * test) triggers a plan rewrite on this test's own rows + a re-run - up to MAX_INVESTIGATOR_ITERATIONS passes;
 * the final pass withholds the re-run, so a still-`test_is_wrong` test resolves to `delete` (eager self-delete).
 * `planEdited` records whether any self-heal rewrite was applied - the fidelity signal that replaces PlanFidelity.
 */
async function runWithSelfHeal(
    snapshotId: string,
    slug: string,
    testGenerationId: string,
    scenarioId: string | undefined,
    reason: string,
    origin: AnalysisTestOrigin,
): Promise<AnalysisCandidateFinding> {
    let generationId = testGenerationId;
    let currentScenarioId = scenarioId;
    let currentReason = reason;
    let planEdited = false;

    for (let iteration = 1; iteration <= MAX_INVESTIGATOR_ITERATIONS; iteration++) {
        const outcome = await runAndClassify(snapshotId, slug, generationId, currentScenarioId, currentReason);
        if (outcome.kind === "fault") {
            return { slug, category: outcome.category, headline: outcome.headline, planEdited, origin };
        }

        const routed = routeVerdict(outcome.verdict.category);
        if (routed !== TEST_IS_WRONG) {
            return {
                slug,
                category: routed,
                headline: outcome.verdict.headline,
                planEdited,
                origin,
                report: toFindingReport(outcome.result),
            };
        }

        // The test looks wrong on a healthy app. Try one self-heal rewrite + re-run, unless this is the final
        // iteration - which withholds the plan-edit path so the loop always terminates.
        const isFinalIteration = iteration === MAX_INVESTIGATOR_ITERATIONS;
        const rerun = isFinalIteration ? undefined : await prepareSelfHealRerun(snapshotId, slug, outcome.verdict);
        if (rerun == null) {
            return resolveToDelete(snapshotId, slug, outcome.verdict, outcome.result, planEdited, origin);
        }

        log.info("Self-healing: rewrote the plan on the test's own rows; re-running", {
            snapshot: { snapshotId },
            extra: { slug, iteration, category: outcome.verdict.category },
        });
        planEdited = true;
        generationId = rerun.testGenerationId;
        currentScenarioId = rerun.scenarioId;
        currentReason = SELF_HEAL_RERUN_REASON;
    }

    // The final iteration always returns (a terminal verdict, or `delete` when it withholds the re-run), so the
    // loop never falls through. This fail-safe keeps the return total for the type checker.
    return { slug, category: "engine_artifact", headline: "Investigator produced no verdict", planEdited, origin };
}

/**
 * Map the classifier's Category (an opaque string here) onto the Investigator's terminal taxonomy, or the
 * transient `test_is_wrong` bucket. `passed`, `client_bug`, `engine_artifact`, `environment_failure`, and
 * `scenario_issue` pass through 1:1; `outdated_test`/`bad_test` collapse to `test_is_wrong`. `delete` is never a
 * classifier output (the Investigator derives it), and an unrecognized category is treated as `engine_artifact`
 * - a coverage-plane fault, never a silent drop and never a bug against the PR.
 *
 * Coupled to the copied classifier's `Category` enum (`@autonoma/diffs/analysis`): the category literals are
 * hardcoded because the workflow sandbox cannot import that package to reference the enum by symbol.
 */
function routeVerdict(category: string): AnalysisVerdict | typeof TEST_IS_WRONG {
    if (TEST_IS_WRONG_CATEGORIES.has(category)) return TEST_IS_WRONG;
    switch (category) {
        case "passed":
        case "client_bug":
        case "engine_artifact":
        case "environment_failure":
        case "scenario_issue":
            return category;
        default:
            return "engine_artifact";
    }
}

/** The outcome of one run+classify pass: a real classifier verdict (with the full rich result to persist), or a
 * contained fault mapped to a verdict. */
type ClassifyOutcome =
    | { kind: "verdict"; verdict: InvestigationVerdict; result: InvestigationTestResult }
    | { kind: "fault"; category: AnalysisVerdict; headline: string };

/**
 * Map the classifier's rich result onto the finding's evidence bundle - the full output the pipeline used to
 * discard. The Reconciler persists it onto the `AnalysisFinding` row, which is what the UI renders (a
 * `client_bug` carries its evidence here, not in any Bug/Issue). Media ride as `s3://` keys (signed on read).
 * Pure shaping; the runner fields (`videoUrl`/`finalScreenshotUrl`/`clipUrl`) are already storage keys despite
 * their names.
 */
function toFindingReport(result: InvestigationTestResult): AnalysisFindingReport {
    const verdict = result.verdict;
    return {
        confidence: verdict?.confidence,
        whatHappened: verdict?.whatHappened,
        rootCause: verdict?.rootCause,
        remediation: verdict?.remediation,
        observedAppIssues: verdict?.observedAppIssues,
        falsePositiveRisk: verdict?.falsePositiveRisk,
        plan: result.plan,
        runSuccess: result.runSuccess,
        stepCount: result.stepCount,
        runSteps: result.runSteps,
        runTrace: result.runTrace,
        evidence: verdict?.evidence,
        videoKey: result.videoUrl,
        screenshotKey: result.finalScreenshotUrl,
        clipKey: result.clipUrl,
        error: result.error,
    };
}

/**
 * Author the classifier's revised plan onto THIS test's own (snapshot, testCase) rows and prepare a fresh shadow
 * generation to re-run: `selfHealAnalysisTest` applies `UpdateTest` via the TestSuiteUpdater on the detached
 * snapshot, editing this test case's plan in place (slug preserved, scenario preserved) and queuing one
 * generation - it never repoints any other test. Returns undefined - fall through to `delete` - when the
 * classifier proposed no revised plan (e.g. the feature is gone, so a rewrite would be a fabrication) or no
 * generation could be prepared.
 */
async function prepareSelfHealRerun(
    snapshotId: string,
    slug: string,
    verdict: InvestigationVerdict,
): Promise<{ testGenerationId: string; scenarioId?: string } | undefined> {
    const revisedPlan = verdict.suggestedTestUpdate;
    if (revisedPlan == null || revisedPlan === "") {
        log.info("Test looks wrong but the classifier proposed no revised plan; will delete the test", {
            snapshot: { snapshotId },
            extra: { slug, category: verdict.category },
        });
        return undefined;
    }

    const created = await investigator.selfHealAnalysisTest({ snapshotId, slug, plan: revisedPlan });
    if (created.testGenerationId == null) {
        log.info("Could not prepare a self-heal re-run; will delete the test", {
            snapshot: { snapshotId },
            extra: { slug, reason: created.skippedReason ?? "no generation prepared" },
        });
        return undefined;
    }
    return { testGenerationId: created.testGenerationId, scenarioId: created.scenarioId };
}

/**
 * Resolve an exhausted `test_is_wrong` loop to the `delete` terminal: the app rendered correctly but the test
 * could not be stabilized, so the Investigator eagerly self-deletes its OWN test on the twin (a row-local write).
 * `origin` decides the scope: a `pre_existing` (affected) test drops only this snapshot's assignment (its global
 * TestCase is a real suite member); a `proposed` test - authored this run, so it exists only for this run - is
 * removed whole. Contained: a delete failure never sinks the finding. The finding keeps the classifier's account
 * as its headline and carries `origin` so the report can tell an obsolete test from an un-establishable proposal.
 */
async function resolveToDelete(
    snapshotId: string,
    slug: string,
    verdict: InvestigationVerdict,
    result: InvestigationTestResult,
    planEdited: boolean,
    origin: AnalysisTestOrigin,
): Promise<AnalysisCandidateFinding> {
    log.info("Test could not be stabilized on a healthy app; deleting its own row", {
        snapshot: { snapshotId },
        extra: { slug, category: verdict.category, planEdited, origin },
    });
    try {
        const deletion = await investigator.deleteAnalysisTest({ snapshotId, slug, origin });
        log.info("Self-delete complete", {
            snapshot: { snapshotId },
            extra: { slug, deleted: deletion.deleted, reason: deletion.reason },
        });
    } catch (error) {
        log.warn("Self-delete failed; still reporting the delete verdict", {
            snapshot: { snapshotId },
            extra: { slug, message: rootFailureMessage(error) },
        });
    }
    return {
        slug,
        category: "delete",
        headline: verdict.headline,
        planEdited,
        origin,
        report: toFindingReport(result),
    };
}

/**
 * Provision the scenario (if the test pins one), run the shadow generation, and classify it. A failed browser run
 * is still classified - the failure IS the signal we want. Always tears the scenario down. Never throws: a
 * provisioning or classification fault is contained as a coverage-plane verdict (environment_failure /
 * scenario_issue when the error is a recognizable infra failure, else engine_artifact) so a single test's fault
 * stays contained to this child and never fails the parent's fan-out - and never vanishes as a silent drop.
 */
async function runAndClassify(
    snapshotId: string,
    slug: string,
    testGenerationId: string,
    scenarioId: string | undefined,
    reason: string,
): Promise<ClassifyOutcome> {
    let scenarioInstanceId: string | undefined;
    if (scenarioId != null) {
        try {
            const up = await general.scenarioUp({ entityId: testGenerationId, scenarioId });
            scenarioInstanceId = up.scenarioInstanceId;
        } catch (error) {
            const message = rootFailureMessage(error);
            log.warn("Scenario setup failed; the app was never exercised", {
                snapshot: { snapshotId },
                extra: { slug, message },
            });
            return faultOutcome(message, "Scenario setup failed before the app was exercised");
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
        if (result.verdict == null) {
            log.warn("Classifier returned no verdict; containing this test as an engine artifact", {
                snapshot: { snapshotId },
                extra: { slug },
            });
            return { kind: "fault", category: "engine_artifact", headline: "The classifier produced no verdict" };
        }
        return { kind: "verdict", verdict: result.verdict, result };
    } catch (error) {
        const message = rootFailureMessage(error);
        log.error("Classification failed; containing this test", {
            snapshot: { snapshotId },
            extra: { slug, message },
        });
        return faultOutcome(message, "The run could not be classified");
    } finally {
        // Never let a teardown error escape - it would mask the outcome this function just resolved. Tear down
        // outside cancellation so a superseded run still releases the scenario instance.
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

/**
 * Build a contained coverage-plane finding for a run/classify fault. A recognizable infra error maps to
 * environment_failure / scenario_issue (the failure is attributable to the environment or the scenario data, not
 * the PR); anything else is an engine_artifact (a harness fault). The underlying message rides along in the
 * headline (capped) so the shadow finding is self-explanatory.
 */
function faultOutcome(message: string, prefix: string): ClassifyOutcome {
    const category: AnalysisVerdict = categorizeInfraFailure(message) ?? "engine_artifact";
    const detail = message.length > FAULT_DETAIL_CAP ? `${message.slice(0, FAULT_DETAIL_CAP)}...` : message;
    return { kind: "fault", category, headline: `${prefix}: ${detail}` };
}
