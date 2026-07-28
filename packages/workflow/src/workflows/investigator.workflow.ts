import {
    type AnalysisClassificationReport,
    type AnalysisTestIsWrongCategory,
    type AnalysisTestOrigin,
    type AnalysisVerdict,
    analysisTestIsWrongCategorySchema,
} from "@autonoma/types";
import { CancellationScope, log, proxyActivities } from "@temporalio/workflow";
import type {
    AnalysisCandidateClassification,
    AnalysisCandidateFinding,
    GeneralActivities,
    InvestigationActivities,
    InvestigationTestResult,
    InvestigationVerdict,
    InvestigatorActivities,
    PersistAnalysisClassificationOutput,
    WebActivities,
} from "../activities";
import { rootFailureMessage } from "../root-failure-message";
import { categorizeInfraFailure } from "../scenario-setup-failure";
import { TaskQueue } from "../task-queues";

/**
 * Max run+classify iterations for one test: the initial run plus, on a "test is wrong" verdict, a single self-heal
 * re-run of a rewritten plan. Bounded so the loop always terminates - the final iteration never rewrites nor
 * re-runs (the plan-edit path is withheld), which is what guarantees termination and forces a still-wrong test to
 * `delete`.
 */
const MAX_INVESTIGATOR_ITERATIONS = 2;

/**
 * The classification slot the PARENT files a crashed child's containment fault under. Past every slot the child
 * could have used, so containing a crash never restates an iteration the child did reach - and re-containing the
 * same child restates its own row rather than appending a second fault.
 */
export const CONTAINMENT_CLASSIFICATION_NUMBER = MAX_INVESTIGATOR_ITERATIONS + 1;

/**
 * Where one classifier verdict routes. `test_is_wrong` is the transient loop bucket: the APP rendered correctly but
 * the TEST itself is wrong (a stale plan, or a plan wrong by design - the old `outdated_test` + `bad_test`). It is
 * NEVER a finding's terminal verdict; it drives a self-heal plan rewrite + re-run, and when the loop exhausts on a
 * healthy app it resolves to the `delete` terminal. The iteration that reached it still persists its own
 * classification, which is what makes a wrong self-heal auditable afterwards - so the routing carries the raw
 * category along rather than collapsing it to a sentinel the persist call would have to widen back to a string.
 */
type RoutedVerdict =
    | { kind: "terminal"; category: AnalysisVerdict }
    | { kind: "test_is_wrong"; category: AnalysisTestIsWrongCategory };

/** Reason recorded for a self-heal re-run, fed to the classifier as context for the follow-up iteration. */
const SELF_HEAL_RERUN_REASON =
    "Re-running after a self-heal plan rewrite: the prior run indicated a stale/incorrect test on a healthy app.";

/** How much of a fault's underlying error message to carry into the finding headline (the rest is only logged). */
const FAULT_DETAIL_CAP = 200;

/**
 * Classification is the long pole of an Investigator pass: the vision probes, then a multi-step tool loop whose
 * `analyze_video` reads re-send the whole recording, then the verdict call. Its own abort timeouts (3m probe +
 * 12m investigation + 6m verdict) are what actually bound it, and they sum ABOVE 20m - so startToClose, the
 * outer net, has to sit above that sum or Temporal kills a classification that is still making progress and the
 * test is contained as an engine artifact instead of getting a verdict.
 */
const investigation = proxyActivities<InvestigationActivities>({
    startToCloseTimeout: "30m",
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
    /** The test's id - what its finding is keyed on. */
    testCaseId: string;
    /** The generation to run for this test (created up front by Impact Analysis). */
    testGenerationId: string;
    /** The scenario to provision before the run, when the test pins one. */
    scenarioId?: string;
    /** Why the test was selected - passed to the classifier as context, and stored on the finding. */
    reason: string;
    /** Whether this test pre-existed (affected) or was authored this run (proposed). Rides onto the finding and
     * decides how the report narrates a `delete`. */
    origin: AnalysisTestOrigin;
}

/**
 * Investigator (child workflow, one per test): run the test's generation on the web worker, classify the outcome,
 * and resolve ONE terminal verdict across the full two-plane taxonomy. It writes no rows other than its own test's
 * (plan edit + eager self-delete) and files no bugs (the Reporter owns the cross-test reconciliation).
 *
 * When a run shows the TEST itself is wrong on a healthy app it self-heals: rewrite the plan on this test's own
 * rows and re-run, bounded by MAX_INVESTIGATOR_ITERATIONS. If that loop exhausts (the final iteration withholds the
 * re-run), the test is a correct-app test we cannot stabilize, so it resolves to `delete` and the Investigator
 * eagerly drops its own assignment. It ALWAYS reaches a verdict - a scenario/classify fault is contained as a
 * coverage-plane one (environment_failure / scenario_issue / engine_artifact), never a silent drop.
 *
 * EVERY iteration persists its own classification as it happens, so the verdict that authored a self-heal survives
 * the rewrite that followed it, and a crash mid-loop still leaves what the loop had concluded so far.
 */
export async function investigatorWorkflow(input: InvestigatorWorkflowInput): Promise<AnalysisCandidateFinding> {
    const { snapshotId, slug, testCaseId, testGenerationId, scenarioId, reason, origin } = input;
    const ids = { snapshot: { snapshotId } };
    log.info("Investigator workflow started", { ...ids, extra: { slug, origin } });

    const finding = await runWithSelfHeal({
        snapshotId,
        slug,
        testCaseId,
        testGenerationId,
        scenarioId,
        reason,
        origin,
    });
    log.info("Investigator workflow finished", {
        ...ids,
        extra: { slug, category: finding.category, origin: finding.origin },
    });
    return finding;
}

interface SelfHealParams {
    snapshotId: string;
    slug: string;
    testCaseId: string;
    testGenerationId: string;
    scenarioId?: string;
    reason: string;
    origin: AnalysisTestOrigin;
}

/**
 * Files one iteration's outcome against this test's finding, creating the finding on the first call. `number` is
 * the loop's own iteration counter and is what makes the write idempotent - re-filing a slot restates it.
 */
type PersistClassification = (
    number: number,
    classification: AnalysisCandidateClassification,
) => Promise<PersistAnalysisClassificationOutput>;

/**
 * Run the test and route its verdict. A terminal verdict (client_bug / passed / engine_artifact /
 * environment_failure / scenario_issue) is returned immediately. A `test_is_wrong` verdict (healthy app, wrong
 * test) triggers a plan rewrite on this test's own rows + a re-run - up to MAX_INVESTIGATOR_ITERATIONS iterations;
 * the final one withholds the re-run, so a still-`test_is_wrong` test resolves to `delete` (eager self-delete).
 *
 * Each iteration persists its classification before the loop decides what to do next, so the rewrite is always
 * authored AFTER the verdict that motivated it is on disk.
 */
async function runWithSelfHeal(params: SelfHealParams): Promise<AnalysisCandidateFinding> {
    const { snapshotId, slug, testCaseId, reason, origin } = params;
    let generationId = params.testGenerationId;
    let currentScenarioId = params.scenarioId;
    let currentReason = reason;
    // The prior iteration's verdict, carried into a self-heal re-run's classify call so the second iteration judges
    // the corrected plan against the first's conclusion instead of re-investigating from scratch.
    let priorPass: { category: string; headline: string; rootCause?: string } | undefined;

    // `reason` is the ORIGINAL selection reason (the loop reassigns a separate `currentReason` for re-runs), which
    // is the provenance the Reporter wants on the finding.
    const persist: PersistClassification = (number, classification) =>
        investigator.persistAnalysisClassification({
            snapshotId,
            testCaseId,
            origin,
            selectionReason: reason,
            number,
            classification,
        });

    for (let iteration = 1; iteration <= MAX_INVESTIGATOR_ITERATIONS; iteration++) {
        const outcome = await runAndClassify(
            snapshotId,
            slug,
            generationId,
            currentScenarioId,
            currentReason,
            priorPass,
        );
        if (outcome.kind === "fault") {
            await persist(iteration, { generationId, category: outcome.category, headline: outcome.headline });
            return { slug, testCaseId, generationId, category: outcome.category, headline: outcome.headline, origin };
        }

        const report = toClassificationReport(outcome.result);
        const routed = routeVerdict(outcome.verdict.category);
        if (routed.kind === "terminal") {
            const { category } = routed;
            await persist(iteration, { generationId, category, headline: outcome.verdict.headline, report });
            return { slug, testCaseId, generationId, category, headline: outcome.verdict.headline, origin };
        }

        // The test looks wrong on a healthy app. A self-heal rewrite + re-run is available unless this is the
        // final iteration (which withholds the plan-edit path so the loop always terminates) or the classifier
        // proposed no revised plan - in either case the loop is over and this iteration IS the `delete`.
        const isFinalIteration = iteration === MAX_INVESTIGATOR_ITERATIONS;
        const revisedPlan = outcome.verdict.suggestedTestUpdate;
        const canSelfHeal = !isFinalIteration && revisedPlan != null && revisedPlan !== "";
        if (!canSelfHeal) {
            return await resolveToDelete({
                snapshotId,
                slug,
                testCaseId,
                generationId,
                number: iteration,
                verdict: outcome.verdict,
                report,
                origin,
                persist,
            });
        }

        // This iteration is about to be superseded by the rewrite it motivates, so persist it BEFORE authoring
        // that rewrite: a plan must never be edited on the strength of a verdict that is not on disk. It keeps its
        // raw classifier category and its own conversation, which is what makes a wrong self-heal auditable.
        await persist(iteration, {
            generationId,
            category: routed.category,
            headline: outcome.verdict.headline,
            report,
        });

        const rerun = await prepareSelfHealRerun(snapshotId, slug, revisedPlan);
        if (rerun == null) {
            // The rewrite never landed, so this iteration is still the one being recorded - re-filing its slot
            // restates the row just written, replacing the superseded verdict with the `delete` it resolves to.
            return await resolveToDelete({
                snapshotId,
                slug,
                testCaseId,
                generationId,
                number: iteration,
                verdict: outcome.verdict,
                report,
                origin,
                persist,
            });
        }

        log.info("Self-healing: rewrote the plan on the test's own rows; re-running", {
            snapshot: { snapshotId },
            extra: { slug, iteration, category: outcome.verdict.category },
        });
        generationId = rerun.testGenerationId;
        currentScenarioId = rerun.scenarioId;
        currentReason = SELF_HEAL_RERUN_REASON;
        priorPass = {
            category: outcome.verdict.category,
            headline: outcome.verdict.headline,
            rootCause: outcome.verdict.rootCause,
        };
    }

    // The final iteration always returns (a terminal verdict, or `delete` when it withholds the re-run), so the
    // loop never falls through. This fail-safe keeps the return total for the type checker.
    return {
        slug,
        testCaseId,
        generationId,
        category: "engine_artifact",
        headline: "Investigator produced no verdict",
        origin,
    };
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
function routeVerdict(category: string): RoutedVerdict {
    const raw = analysisTestIsWrongCategorySchema.safeParse(category);
    if (raw.success) return { kind: "test_is_wrong", category: raw.data };
    switch (category) {
        case "passed":
        case "client_bug":
        case "engine_artifact":
        case "environment_failure":
        case "scenario_issue":
            return { kind: "terminal", category };
        default:
            return { kind: "terminal", category: "engine_artifact" };
    }
}

/** The outcome of one run+classify iteration: a real classifier verdict (with the full rich result to persist), or
 * a contained fault mapped to a verdict. */
type ClassifyOutcome =
    | { kind: "verdict"; verdict: InvestigationVerdict; result: InvestigationTestResult }
    | { kind: "fault"; category: AnalysisVerdict; headline: string };

/**
 * Map the classifier's rich result onto the classification's evidence bundle - the full output the pipeline used to
 * discard. It is persisted onto this iteration's `AnalysisClassification` row, which is what the UI renders (a
 * `client_bug` carries its evidence here, not in any Bug/Issue). Media ride as `s3://` keys (signed on read).
 * Pure shaping; the runner fields (`videoUrl`/`finalScreenshotUrl`/`clipUrl`) are already storage keys despite
 * their names.
 */
function toClassificationReport(result: InvestigationTestResult): AnalysisClassificationReport {
    const verdict = result.verdict;
    return {
        confidence: verdict?.confidence,
        expectedBehavior: verdict?.expectedBehavior,
        actualBehavior: verdict?.actualBehavior,
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
        optimizedVideoKey: result.optimizedVideoUrl,
        screenshotKey: result.finalScreenshotUrl,
        clipKey: result.clipUrl,
        conversationUrl: result.conversationUrl,
        error: result.error,
    };
}

/**
 * Author the classifier's revised plan onto THIS test's own (snapshot, testCase) rows and prepare a fresh shadow
 * generation to re-run: `selfHealAnalysisTest` applies `UpdateTest` via the TestSuiteUpdater on the detached
 * snapshot, editing this test case's plan in place (slug preserved, scenario preserved) and queuing one
 * generation - it never repoints any other test. Returns undefined - fall through to `delete` - when no generation
 * could be prepared (e.g. the slug has no assignment on the snapshot).
 */
async function prepareSelfHealRerun(
    snapshotId: string,
    slug: string,
    revisedPlan: string,
): Promise<{ testGenerationId: string; scenarioId?: string } | undefined> {
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

interface ResolveToDeleteParams {
    snapshotId: string;
    slug: string;
    testCaseId: string;
    generationId: string;
    /** The iteration that reached this conclusion - the slot its classification is filed under. */
    number: number;
    verdict: InvestigationVerdict;
    /** This run's evidence, carried onto the `delete` so the finding renders the run it was derived from. */
    report: AnalysisClassificationReport;
    origin: AnalysisTestOrigin;
    persist: PersistClassification;
}

/**
 * Resolve a `test_is_wrong` iteration with no rewrite left to the `delete` terminal: the app rendered correctly but
 * the test could not be stabilized, so the Investigator drops its OWN test's assignment on the twin (a row-local
 * write). The verdict is recorded FIRST - the removal is a consequence of the verdict, and a removal we cannot
 * explain is worse than one we failed to make. Contained either way: a delete failure never sinks the verdict.
 *
 * The classification carries `delete` rather than the classifier's raw `outdated_test`/`bad_test`, because `delete`
 * is what this iteration concluded; an earlier iteration's raw category stays untouched on its own row.
 */
async function resolveToDelete({
    snapshotId,
    slug,
    testCaseId,
    generationId,
    number,
    verdict,
    report,
    origin,
    persist,
}: ResolveToDeleteParams): Promise<AnalysisCandidateFinding> {
    log.info("Test could not be stabilized on a healthy app; removing its assignment", {
        snapshot: { snapshotId },
        extra: { slug, category: verdict.category, origin },
    });
    await persist(number, { generationId, category: "delete", headline: verdict.headline, report });

    try {
        const deletion = await investigator.deleteAnalysisTest({ snapshotId, slug });
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
    return { slug, testCaseId, generationId, category: "delete", headline: verdict.headline, origin };
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
    priorPass?: { category: string; headline: string; rootCause?: string },
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
        const result = await investigation.classifyInvestigationRun({
            snapshotId,
            slug,
            reason,
            testGenerationId,
            priorPass,
        });
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
 * Build a contained coverage-plane outcome for a run/classify fault. A recognizable infra error maps to
 * environment_failure / scenario_issue (the failure is attributable to the environment or the scenario data, not
 * the PR); anything else is an engine_artifact (a harness fault). The underlying message rides along in the
 * headline (capped) so the shadow finding is self-explanatory.
 */
function faultOutcome(message: string, prefix: string): ClassifyOutcome {
    const category: AnalysisVerdict = categorizeInfraFailure(message) ?? "engine_artifact";
    const detail = message.length > FAULT_DETAIL_CAP ? `${message.slice(0, FAULT_DETAIL_CAP)}...` : message;
    return { kind: "fault", category, headline: `${prefix}: ${detail}` };
}
