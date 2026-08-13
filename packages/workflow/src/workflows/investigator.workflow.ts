import {
    type AnalysisClassificationReport,
    type AnalysisTestOrigin,
    type AnalysisVerdict,
    SELF_HEAL_RERUN_REASON,
    analysisVerdictSchema,
    mapSdkFailureToVerdict,
} from "@autonoma/types";
import { CancellationScope, log, proxyActivities } from "@temporalio/workflow";
import type {
    AnalysisActivities,
    AnalysisCandidateClassification,
    AnalysisCandidateFinding,
    GeneralActivities,
    InvestigationEvidence,
    InvestigationTestResult,
    InvestigationVerdict,
    PersistAnalysisClassificationOutput,
    WebActivities,
} from "../activities";
import { rootFailureMessage } from "../root-failure-message";
import { categorizeInfraFailure } from "../rules/infra-failure";
import { sdkFailureFromError } from "../sdk-failure-from-error";
import { TaskQueue } from "../task-queues";

/**
 * Max run+classify iterations for one test: the initial run plus, on a `plan_mismatch` verdict, a single self-heal
 * re-run of a rewritten plan. Bounded so the loop always terminates - the final iteration never rewrites nor
 * re-runs (the plan-edit path is withheld), which guarantees termination and resolves a still-wrong test to a KEPT
 * `plan_mismatch` (never removed).
 */
const MAX_INVESTIGATOR_ITERATIONS = 2;

/** How much of a fault's underlying error message to carry into the finding headline (the rest is only logged). */
const FAULT_DETAIL_CAP = 200;

/** The complete first-pass record a self-heal re-run needs to judge the repair rather than rediscover it. */
interface SelfHealPriorPass {
    category: string;
    headline: string;
    rootCause?: string;
    plan: string;
    planMismatchNote?: string;
    evidence: InvestigationEvidence[];
}

/**
 * Classification is the long pole of an Investigator pass: the vision probes, then a multi-step tool loop whose
 * `analyze_video` reads re-send the whole recording, then the verdict call. Its own abort timeouts (3m probe +
 * 12m investigation + 6m verdict) are what actually bound it, and they sum ABOVE 20m - so startToClose, the
 * outer net, has to sit above that sum or Temporal kills a classification that is still making progress and the
 * test is contained as an engine artifact instead of getting a verdict.
 */
const investigation = proxyActivities<Pick<AnalysisActivities, "classifyInvestigationRun">>({
    startToCloseTimeout: "30m",
    heartbeatTimeout: "2m",
    retry: { maximumAttempts: 1 },
    taskQueue: TaskQueue.DIFFS,
});

const investigator = proxyActivities<
    Pick<
        AnalysisActivities,
        | "startInvestigationRun"
        | "selfHealAnalysisTest"
        | "revertSelfHealPlan"
        | "deleteAnalysisTest"
        | "persistAnalysisClassification"
    >
>({
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
    /** The test's id - what its finding is keyed on, and what each of its runs is started from. */
    testCaseId: string;
    /** Why the test was selected - passed to the classifier as context, and stored on the finding. */
    reason: string;
    /** Whether this test pre-existed (affected) or was authored this run (proposed). Rides onto the finding, which is
     * how the suite-changes view groups it and how the report tells the two apart. */
    origin: AnalysisTestOrigin;
}

/**
 * Investigator (child workflow, one per test): start a run of the test's pinned plan, execute it on the web
 * worker, classify the outcome, and resolve ONE terminal verdict across the full two-plane taxonomy. It starts its
 * own runs - a target is a test, and `startInvestigationRun` fires immediately before provisioning so a scenario
 * failure still has a run to hang its classification on. It writes no rows other than its own test's (a self-heal
 * plan edit, and the revert of that edit when a plan_mismatch is kept) and files no bugs (the Reporter owns the
 * cross-test reconciliation).
 *
 * When a run shows the TEST's plan is wrong on a healthy app it self-heals: rewrite the plan on this test's own rows
 * and re-run, bounded by MAX_INVESTIGATOR_ITERATIONS. If that loop exhausts (the final iteration withholds the
 * re-run), the test is a correct-app test we cannot stabilize, so it resolves to a KEPT `plan_mismatch` - the
 * Investigator does NOT remove it, and reverts the failed rewrite so the test's original plan is what promotes. It
 * ALWAYS reaches a verdict - a scenario/classify fault is contained as a coverage-plane one (environment_failure /
 * scenario_issue / engine_artifact), never a silent drop.
 *
 * EVERY iteration persists its own classification as it happens, so the verdict that authored a self-heal survives
 * the rewrite that followed it, and a crash mid-loop still leaves what the loop had concluded so far.
 */
export async function investigatorWorkflow(input: InvestigatorWorkflowInput): Promise<AnalysisCandidateFinding> {
    const { snapshotId, slug, testCaseId, reason, origin } = input;
    const ids = { snapshot: { snapshotId } };
    log.info("Investigator workflow started", { ...ids, extra: { slug, origin } });

    const finding = await runWithSelfHeal({ snapshotId, slug, testCaseId, reason, origin });
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
 * environment_failure / scenario_issue) is returned immediately. A `test_is_wrong` verdict (healthy app, the test's
 * plan does not match it) triggers a plan rewrite on this test's own rows + a re-run - up to
 * MAX_INVESTIGATOR_ITERATIONS iterations; the final one withholds the re-run, so a still-wrong test resolves to a KEPT
 * `plan_mismatch` with any rewrite reverted.
 *
 * Each iteration starts its own run (which resolves the plan the snapshot pins at that moment - after a self-heal,
 * the rewritten one, with the scenario it preserved) and persists its classification before the loop decides what
 * to do next, so the rewrite is always authored AFTER the verdict that motivated it is on disk.
 */
async function runWithSelfHeal(params: SelfHealParams): Promise<AnalysisCandidateFinding> {
    const { snapshotId, slug, testCaseId, reason, origin } = params;
    let currentReason = reason;
    // The prior iteration's verdict, carried into a self-heal re-run's classify call so the second iteration judges
    // the corrected plan against the first's conclusion instead of re-investigating from scratch.
    let priorPass: SelfHealPriorPass | undefined;
    // The plan record the assignment held before a self-heal rewrite. Set if and only if a rewrite landed - self-heal
    // refuses to rewrite what it cannot undo - so this being absent means there is nothing to put back.
    let planIdBeforeSelfHeal: string | undefined;

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
        // A failure to even start the run is NOT contained here: with no run there is nothing to classify against,
        // so the child crashes and the parent's containment files the fault instead.
        const started = await investigator.startInvestigationRun({ snapshotId, testCaseId });

        const outcome = await runAndClassify(
            snapshotId,
            slug,
            started.runId,
            started.scenarioId,
            currentReason,
            priorPass,
        );
        if (outcome.kind === "fault") {
            await persist(iteration, {
                generationId: started.runId,
                category: outcome.category,
                headline: outcome.headline,
            });
            return { slug, testCaseId, category: outcome.category, headline: outcome.headline, origin };
        }

        const report = toClassificationReport(outcome.result);
        const category = routeVerdict(outcome.verdict.category);
        const headline = outcome.verdict.headline;
        // File the verdict BEFORE acting on it, on every path: a plan is never edited on the strength of a verdict that
        // is not on disk, and an iteration a self-heal supersedes keeps its own row (with its own classifier
        // conversation), which is what makes a wrong self-heal auditable afterwards.
        await persist(iteration, { generationId: started.runId, category, headline, report });
        const finding: AnalysisCandidateFinding = { slug, testCaseId, category, headline, origin };

        // `invalid_test` is a deliberate coverage-plane REMOVAL - the classifier proved the test is irreparable, so
        // its assignment is dropped via the uniform dropTest path (contained; the classification record - the WHY -
        // is preserved regardless). Reachable up front (a provable impossibility) or on the final self-heal iteration.
        // On that post-heal path a rewrite has already repointed the assignment at a plan the run knows fails, so if
        // the removal does not land, `planIdBeforeSelfHeal` is passed to undo it - the snapshot must never promote a
        // known-failing rewrite for a test the run declared irreparable.
        if (category === "invalid_test") await removeInvalidTest(snapshotId, slug, planIdBeforeSelfHeal);
        // Every verdict but `plan_mismatch` is final on the spot. `plan_mismatch` means the app rendered correctly and
        // the test's plan does not match it, so it gets a self-heal attempt before it settles.
        if (category !== "plan_mismatch") return finding;

        // A rewrite + re-run is available unless this is the final iteration (which withholds the plan-edit path so the
        // loop always terminates) or the classifier proposed no revised plan.
        const isFinalIteration = iteration === MAX_INVESTIGATOR_ITERATIONS;
        const revisedPlan = outcome.verdict.suggestedTestUpdate;
        const canSelfHeal = !isFinalIteration && revisedPlan != null && revisedPlan !== "";
        if (!canSelfHeal) {
            // Out of self-heal budget: the test is KEPT as `plan_mismatch`, never removed - it may be salvageable in a
            // later snapshot, or may be surfacing a defect the classifier misdiagnosed.
            log.info("Test could not be stabilized on a healthy app; keeping it as plan_mismatch", {
                snapshot: { snapshotId },
                extra: { slug, origin, revertToPlanId: planIdBeforeSelfHeal },
            });
            await revertSelfHealRewrite(snapshotId, slug, planIdBeforeSelfHeal);
            return finding;
        }

        const rewrote = await prepareSelfHealRewrite(snapshotId, slug, revisedPlan);
        // The rewrite never landed, so this iteration's verdict - already filed - is the one the run stands behind, and
        // there is no plan edit to undo.
        if (rewrote == null) return finding;

        log.info("Self-healing: rewrote the plan on the test's own rows; re-running", {
            snapshot: { snapshotId },
            extra: { slug, iteration, category },
        });
        // Hold the id the rewrite replaced so a later kept `plan_mismatch` restores the plan the loop STARTED from -
        // never an intermediate rewrite, which is why a second rewrite must not overwrite this.
        planIdBeforeSelfHeal ??= rewrote.previousPlanId;
        currentReason = SELF_HEAL_RERUN_REASON;
        priorPass = {
            category: outcome.verdict.category,
            headline: outcome.verdict.headline,
            rootCause: outcome.verdict.rootCause,
            plan: outcome.result.plan,
            planMismatchNote: outcome.verdict.planMismatchNote,
            evidence: outcome.verdict.evidence,
        };
    }

    // The final iteration always returns (a terminal verdict, or the kept `plan_mismatch` when it withholds the
    // re-run), so the loop never falls through. This fail-safe keeps the return total for the type checker.
    return {
        slug,
        testCaseId,
        category: "engine_artifact",
        headline: "Investigator produced no verdict",
        origin,
    };
}

/**
 * Validate the classifier's category (an opaque string here) as an `AnalysisVerdict`. The classifier's own `Category`
 * enum and this taxonomy hold the same values - `classifier-category-coupling.test.ts` pins that - so every category
 * passes through as itself. An unrecognized one is treated as `engine_artifact`: a coverage-plane fault, never a silent
 * drop and never a bug against the PR.
 *
 * `plan_mismatch` needs no special routing here - it IS a terminal verdict. The loop treats it as the one category that
 * first gets a self-heal attempt, and persists it whether it heals or exhausts.
 */
function routeVerdict(category: string): AnalysisVerdict {
    const parsed = analysisVerdictSchema.safeParse(category);
    return parsed.success ? parsed.data : "engine_artifact";
}

/** The outcome of one run+classify iteration: a real classifier verdict (with the full rich result to persist), or
 * a contained fault mapped to a verdict. */
type ClassifyOutcome =
    | { kind: "verdict"; verdict: InvestigationVerdict; result: InvestigationTestResult }
    | { kind: "fault"; category: AnalysisVerdict; headline: string };

/**
 * Map the classifier's rich result onto the classification's evidence bundle. It is persisted onto this
 * iteration's `AnalysisClassification` row, which is what the UI renders (a
 * `client_bug` carries its evidence here, not in any Bug/Issue). Media ride as `s3://` keys (signed on read).
 * Pure shaping; the runner fields (`videoUrl`/`keyScreenshotUrl`/`clipUrl`) are already storage keys despite
 * their names.
 */
function toClassificationReport(result: InvestigationTestResult): AnalysisClassificationReport {
    const verdict = result.verdict;
    return {
        confidence: verdict?.confidence,
        expectedBehavior: verdict?.expectedBehavior,
        actualBehavior: verdict?.actualBehavior,
        whatHappened: verdict?.whatHappened,
        planMismatchNote: verdict?.planMismatchNote,
        invalidTestNote: verdict?.invalidTestNote,
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
        screenshotKey: result.keyScreenshotUrl,
        clipKey: result.clipUrl,
        conversationUrl: result.conversationUrl,
        error: result.error,
    };
}

/**
 * Author the classifier's revised plan onto THIS test's own (snapshot, testCase) rows: `selfHealAnalysisTest`
 * applies `revisePlan`, repointing this test case's assignment at the rewritten plan (slug preserved, scenario
 * preserved) - it never repoints any other test, and it starts no run (the loop's next iteration does, resolving
 * the rewritten plan). It also reports the plan id it replaced, which is what a kept `plan_mismatch` restores.
 * Returns undefined - the loop then resolves to a kept `plan_mismatch` - when the rewrite could not be applied
 * (e.g. the slug has no assignment on the snapshot).
 */
async function prepareSelfHealRewrite(
    snapshotId: string,
    slug: string,
    revisedPlan: string,
): Promise<{ previousPlanId: string } | undefined> {
    const rewrote = await investigator.selfHealAnalysisTest({ snapshotId, slug, plan: revisedPlan });
    if (!rewrote.prepared) {
        log.info("Could not apply a self-heal rewrite; keeping the test as plan_mismatch", {
            snapshot: { snapshotId },
            extra: { slug, reason: rewrote.skippedReason },
        });
        return undefined;
    }
    return { previousPlanId: rewrote.previousPlanId };
}

/**
 * Undo a self-heal rewrite when the loop settles on a KEPT `plan_mismatch`, by repointing the assignment back at the
 * plan the rewrite replaced. A rewrite is optimized to make the test pass, so it can blunt the very assertion catching a
 * real defect - and a plan we know still fails must never be the one that promotes.
 *
 * A no-op when `planId` is absent, which - because self-heal refuses to rewrite a test it cannot restore - means no
 * rewrite landed and there is nothing to undo. Contained: a failed revert leaves the rewritten plan in place but never
 * sinks the verdict, which is already on disk, and the rewrite stays visible on its own iteration's classification
 * either way.
 */
async function revertSelfHealRewrite(snapshotId: string, slug: string, planId: string | undefined): Promise<void> {
    if (planId == null) return;
    try {
        const reverted = await investigator.revertSelfHealPlan({ snapshotId, slug, planId });
        log.info("Restored the test's pre-self-heal plan", {
            snapshot: { snapshotId },
            extra: { slug, reverted: reverted.reverted, reason: reverted.reason },
        });
    } catch (error) {
        log.warn("Failed to restore the pre-self-heal plan; keeping the test with the rewritten plan", {
            snapshot: { snapshotId },
            extra: { slug, message: rootFailureMessage(error) },
        });
    }
}

/**
 * Remove an `invalid_test`: the classifier proved the test is irreparably broken (a feature that never existed,
 * structurally unexecutable steps, a premise the app contradicts), so its assignment is dropped from the snapshot via
 * the uniform `dropTest` path. The verdict is already on disk by the time this runs; the removal is CONTAINED - a
 * failure to remove never sinks the verdict, and the test's `TestCase` + classification record (the WHY) survive
 * either way. Idempotent: a slug with no assignment is a logged no-op.
 *
 * `revertToPlanId` is set only on the post-heal path (a self-heal rewrite already repointed the assignment at a plan
 * the run knows fails). If the removal does NOT actually drop the assignment - it threw, or reported `deleted: false`
 * - that failing rewrite would otherwise promote, the exact outcome the kept-`plan_mismatch` path reverts to avoid;
 * so we undo it here too. A no-op when the removal succeeded (nothing to promote) or no rewrite landed (id absent).
 */
async function removeInvalidTest(snapshotId: string, slug: string, revertToPlanId: string | undefined): Promise<void> {
    let removed = false;
    try {
        const result = await investigator.deleteAnalysisTest({ snapshotId, slug });
        removed = result.deleted;
        log.info("Removed an invalid test from the snapshot", {
            snapshot: { snapshotId },
            extra: { slug, deleted: result.deleted, reason: result.reason },
        });
    } catch (error) {
        log.warn("Failed to remove an invalid test; keeping its assignment", {
            snapshot: { snapshotId },
            extra: { slug, message: rootFailureMessage(error) },
        });
    }
    if (!removed) await revertSelfHealRewrite(snapshotId, slug, revertToPlanId);
}

/**
 * Provision the scenario (if the test pins one), run the generation, and classify it. A failed browser run
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
    priorPass?: SelfHealPriorPass,
): Promise<ClassifyOutcome> {
    let scenarioInstanceId: string | undefined;
    if (scenarioId != null) {
        try {
            const up = await general.scenarioUp({ entityId: testGenerationId, scenarioId });
            scenarioInstanceId = up.scenarioInstanceId;
        } catch (error) {
            const message = rootFailureMessage(error);
            const failure = sdkFailureFromError(error);
            log.warn("Scenario setup failed; the app was never exercised", {
                snapshot: { snapshotId },
                extra: { slug, message, failureKind: failure?.kind },
            });
            await markGenerationFailed(snapshotId, slug, testGenerationId, { kind: "scenario_setup", message });
            // A real preview/scenario failure always carries the structured SdkFailure tag now, so an absent tag
            // means our own orchestration threw before the SDK call ever happened - contained as an engine artifact,
            // never guessed at from the raw message.
            const category = failure != null ? mapSdkFailureToVerdict(failure) : "engine_artifact";
            return faultOutcome(message, "Scenario setup failed before the app was exercised", category);
        }
    }

    try {
        try {
            await web.runWebGeneration({ testGenerationId });
        } catch (error) {
            const message = rootFailureMessage(error);
            log.warn("Investigation run errored; classifying the failed run anyway", {
                snapshot: { snapshotId },
                extra: { slug, message },
            });
            // The engine records its own terminal status, so this only bites when the activity failed before the
            // engine took ownership (task timeout, worker crash, image pull) - exactly the case that would
            // otherwise strand the generation at `pending`.
            await markGenerationFailed(snapshotId, slug, testGenerationId, { kind: "engine_error", message });
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
        // The classify path is non-SDK (the model API, video reads, verdict shaping) and carries no tag, so the
        // message is its only signal. categorizeInfraFailure stays strict - an unrecognized message is a real
        // classifier bug that must surface as engine_artifact, not be buried as a preview outage.
        const category = categorizeInfraFailure(message) ?? "engine_artifact";
        return faultOutcome(message, "The run could not be classified", category);
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
 * Record WHY a generation never produced a run, on the generation itself. The engine marks its own outcome once it
 * starts, so this covers the paths where it never got that far - an unmarked generation would otherwise sit
 * `pending` forever on a settled snapshot.
 *
 * Contained and non-cancellable: a superseded run still records why its generations failed, and a failure to write
 * the status never sinks the verdict the caller is about to file. The activity itself is idempotent and refuses to
 * overwrite a generation the engine already settled.
 */
async function markGenerationFailed(
    snapshotId: string,
    slug: string,
    testGenerationId: string,
    failure: PrismaJson.GenerationFailure,
): Promise<void> {
    try {
        await CancellationScope.nonCancellable(() => general.markGenerationFailed({ testGenerationId, failure }));
    } catch (error) {
        log.warn("Could not mark the generation as failed; its status stays as the engine left it", {
            snapshot: { snapshotId },
            extra: { slug, testGenerationId, message: rootFailureMessage(error) },
        });
    }
}

/**
 * Build a contained coverage-plane outcome for a run/classify fault from a pre-resolved verdict - the provisioning
 * path maps its structured `SdkFailure` tag, the classify path uses its string match. The underlying message rides
 * along in the headline (capped) so the contained finding is self-explanatory.
 */
function faultOutcome(message: string, prefix: string, category: AnalysisVerdict): ClassifyOutcome {
    const detail = message.length > FAULT_DETAIL_CAP ? `${message.slice(0, FAULT_DETAIL_CAP)}...` : message;
    return { kind: "fault", category, headline: `${prefix}: ${detail}` };
}
