import { CancellationScope, log, proxyActivities } from "@temporalio/workflow";
import type {
    GeneralActivities,
    InvestigationActivities,
    InvestigationProgressStage,
    InvestigationSelectedTest,
    InvestigationTestResult,
    InvestigationVerdict,
    ReconcileInvestigationFindingsOutput,
    TestValidationResult,
    WebActivities,
} from "../activities";
import { rootFailureMessage } from "../root-failure-message";
import { infraFailureResult, scenarioSetupFailureResult } from "../scenario-setup-failure";
import { TaskQueue } from "../task-queues";

/** Max validate->edit->retry passes for a single proposed/modified plan before giving up. */
const MAX_VALIDATION_ITERATIONS = 3;

/**
 * Max outer recipe-repair passes for one scenario: each pass runs the agent, stages its candidate on the twin, and
 * re-runs the real test; a fail feeds the run's account back so the next pass tries a DIFFERENT recipe. Bounded
 * because every pass costs a full agent run + scenario up + web run + classify.
 */
const MAX_RECIPE_REPAIR_ATTEMPTS = 3;

/**
 * How many shadow tests run at once. The shadow job must clear quickly even for PRs with many affected
 * tests, so we fan out instead of running one-at-a-time. Capped to bound concurrent web-worker browsers and
 * concurrent scenario provisions against the client preview; Temporal queues any excess web activities.
 */
const TEST_CONCURRENCY = 10;

const investigation = proxyActivities<InvestigationActivities>({
    startToCloseTimeout: "20m",
    heartbeatTimeout: "2m",
    retry: { maximumAttempts: 1 },
    taskQueue: TaskQueue.INVESTIGATION,
});

/**
 * The recipe-repair agent clones the repo and runs two retrying model calls (each with its own abort timeout) plus
 * SDK dry-run seeds, so its worst-case wall time exceeds the default 20m. Give `proposeRecipeRepair` a longer
 * startToClose ceiling than the agent's own retry budget so a transient resend never trips Temporal mid-repair.
 */
const investigationRepair = proxyActivities<InvestigationActivities>({
    startToCloseTimeout: "30m",
    heartbeatTimeout: "2m",
    retry: { maximumAttempts: 1 },
    taskQueue: TaskQueue.INVESTIGATION,
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

export interface InvestigationWorkflowInput {
    snapshotId: string;
}

/**
 * The shadow comparison agent: select the tests a PR's diff affects, run each as a shadow generation on the
 * web worker, classify the outcome, and write a markdown report to S3. It runs in PARALLEL with the
 * production diffs job and must never interfere with it - so a single test's failure is contained and the
 * workflow always proceeds to write whatever it learned.
 */
export async function investigationWorkflow(input: InvestigationWorkflowInput): Promise<void> {
    const { snapshotId } = input;
    const ids = { snapshot: { snapshotId } };
    log.info("Investigation workflow started", ids);

    try {
        await runInvestigation(input, ids);
    } catch (error) {
        // Any uncontained throw (selection or the report write, ultimately) ends the run without a report - flip
        // the row to `failed` so the PR entry point stops showing "running", then rethrow so Temporal still fails
        // the workflow. Best-effort: markProgress swallows its own errors.
        await markProgress(snapshotId, "failed");
        throw error;
    }
}

/**
 * Best-effort lifecycle write for the PR entry point (running / stage / failed). Fire-and-forget: a progress
 * write must never sink the run, so both the activity and this wrapper swallow their errors.
 */
async function markProgress(
    snapshotId: string,
    status: "running" | "failed",
    stage?: InvestigationProgressStage,
): Promise<void> {
    try {
        await investigation.markInvestigationProgress({ snapshotId, status, stage });
    } catch (error) {
        log.warn("Investigation progress mark failed; continuing", {
            snapshot: { snapshotId },
            extra: { status, stage, message: rootFailureMessage(error) },
        });
    }
}

async function runInvestigation(
    input: InvestigationWorkflowInput,
    ids: { snapshot: { snapshotId: string } },
): Promise<void> {
    const { snapshotId } = input;

    // Fail fast unless this is a `processing` twin: the whole run assumes a detached, still-pending snapshot
    // (selection reads its frozen baseline; persist / recipe-repair stage edits via SnapshotDraft, which
    // requires processing). Point it at an active diffs snapshot by mistake and it would otherwise limp through
    // select + the browser runs and only explode at persist - after burning ~2h of scarce activity slots.
    await investigation.assertSnapshotPending({ snapshotId });

    // Seed a bare `running` row so the PR entry point shows the investigation is in flight before any finding
    // exists. The row is keyed to the twin, which is already paired to the PR snapshot at trigger time, so it
    // resolves back to the PR row immediately.
    await markProgress(snapshotId, "running", "selecting");

    const selection = await investigation.selectInvestigationTests({ snapshotId });
    log.info("Investigation selected tests", { ...ids, extra: { count: selection.tests.length } });

    await markProgress(snapshotId, "running", "running");

    // Run the selected/affected tests AND validate the proposed NEW tests together, under ONE shared concurrency
    // budget. They are independent (new-test proposals seed the app's standard scenario; affected tests use their
    // own pinned scenarios), so making the proposals wait for the whole affected wave would only slow the run -
    // but running two separate wave loops concurrently would double the web-worker/scenario ceiling, so they share
    // a single TEST_CONCURRENCY budget instead. Suggested modifications are NOT validated here - they are derived
    // from the affected-test verdicts, so they run after.
    const results = await runTestsAndValidateProposals(snapshotId, selection.tests, selection.suggested, ids);

    // Route every scenario failure into a repair category (fix_test / recipe_only / recipe_and_sdk / unknown) and
    // compute the concrete candidate recipe - a DRY-RUN for every org (report + PR comment show what WOULD run).
    // Contained + bounded like the runs: a diagnosis failure is logged and dropped, never sinking the report.
    await diagnoseScenarioFailures(snapshotId, results);

    // Autofix (validation step) is gated per org: only opted-in orgs pay to VALIDATE their proposed repairs on
    // the twin (re-seed + re-run the candidate recipe / edited plan). Nothing is written to main here - a repair
    // that is correct for THIS branch can be wrong for main + every other in-flight branch (the branch may have
    // changed the schema or introduced a bad test), so writing it globally would break them until this PR merges,
    // and permanently if it never does. Instead the validated repair stays branch-scoped (recipe fixes on the twin
    // recipe version; test edits on the branch snapshot via persistInvestigationEdits below) and reaches main only
    // when the PR merges - the merge-with-main step reconciles both into a main-proposal. Contained: a validation
    // failure never sinks the report.
    if (selection.autofixEnabled) {
        await applyRecipeRepairs(snapshotId, results);
        await applyTestFixes(snapshotId, results);
    }

    // Validate the classifier's suggested modifications by running each edited plan (validate->edit->retry). This
    // runs here, after the affected wave, because each modification is derived from that test's verdict - unlike
    // new-test proposals (validated concurrently above), it has nothing to run until the verdict exists.
    await validateModifications(snapshotId, results);

    // Persist the agent's add/modify edits onto the (detached) investigation snapshot - a proposed suite the
    // merge-with-main step later reconciles into main. Writes only to the twin, never touching the diffs suite.
    // Prefer the validate->edit->retry result (finalPlan) over the raw proposal when validation ran.
    const modifications = results.flatMap((result) => {
        const update = result.modificationValidation?.finalPlan ?? result.verdict?.suggestedTestUpdate;
        return update != null && update !== "" ? [{ slug: result.slug, plan: update }] : [];
    });
    // Add a proposed test to the twin suite only when it is not a proven-broken plan: if validation ran and the
    // plan could not be made to pass, adding it would seed a red test into the suite, so skip it (it still shows
    // in the report as a proposal that failed validation). When validation did not run (flag off) we add the raw
    // proposal as before - selection already vetted it against the strict authoring bar.
    const newTests = selection.suggested
        .filter((suggestion) => suggestion.validation == null || suggestion.validation.passed)
        .map((suggestion) => ({
            name: suggestion.name,
            description: suggestion.description,
            plan: suggestion.validation?.finalPlan ?? suggestion.instruction,
        }));
    // Deletions are gated behind the same org autofix flag as recipe/test-fix writes: removing a test the PR made
    // obsolete is harder to walk back than an added/edited plan, so off-flag orgs stay observe-only here (the
    // removal recommendations still surface in the report/PR comment). Add/modify above always persist to the twin.
    const removals = selection.autofixEnabled ? selection.quarantine.map((q) => q.slug) : [];
    // Contained like runOneTest: a persist failure must never sink the report (the workflow's invariant).
    try {
        const persisted = await investigation.persistInvestigationEdits({
            snapshotId,
            modifications,
            newTests,
            removals,
        });
        log.info("Investigation edits persisted", {
            ...ids,
            extra: { persisted: persisted.persistedCount, skipped: persisted.skipped.length },
        });
    } catch (error) {
        log.error("Investigation persist failed; continuing to report", {
            ...ids,
            extra: { message: rootFailureMessage(error) },
        });
    }

    await markProgress(snapshotId, "running", "reporting");

    // Reconcile findings before persisting: several tests can surface the SAME underlying issue (one seed gap,
    // one code defect), and the agent collapses those into one enriched finding so the report shows each issue
    // once. Contained: a reconciliation failure must never sink the report - fall back to the unmerged findings.
    let reconciliation: ReconcileInvestigationFindingsOutput = { merges: [] };
    try {
        reconciliation = await investigationRepair.reconcileInvestigationFindings({ snapshotId, results });
        log.info("Investigation findings reconciled", { ...ids, extra: { merges: reconciliation.merges.length } });
    } catch (error) {
        log.warn("Investigation reconciliation failed; reporting findings unmerged", {
            ...ids,
            extra: { message: rootFailureMessage(error) },
        });
    }

    // writeInvestigationReport flips the row to `completed` and clears the stage, so there is no explicit
    // "completed" markProgress here - the report writer owns that terminal transition.
    const report = await investigation.writeInvestigationReport({
        snapshotId,
        results,
        suggested: selection.suggested,
        reconciliation,
    });

    // Post the results to the PR (flag-gated, idempotent). The report is the deliverable and is already
    // written, so a comment failure must never sink the workflow - it's contained and logged.
    try {
        const comment = await investigation.postInvestigationPrComment({
            snapshotId,
            results,
            suggested: selection.suggested,
        });
        log.info("Investigation PR comment step finished", { ...ids, extra: { status: comment.status } });
    } catch (error) {
        log.error("Investigation PR comment failed; report already written, continuing", {
            ...ids,
            extra: { message: rootFailureMessage(error) },
        });
    }

    log.info("Investigation workflow completed", {
        ...ids,
        extra: { testCount: report.testCount, clientBugCount: report.clientBugCount },
    });
}

/**
 * Diagnose every scenario failure into a repair route and attach it to the result in place. Only
 * `scenario_issue` results are diagnosed: those are the failures a recipe/test/factory change could fix.
 * `environment_failure` (preview down) is already "not our problem", and other categories are not data issues.
 * Runs in bounded waves; each diagnosis is contained so a failure never sinks the report.
 */
async function diagnoseScenarioFailures(snapshotId: string, results: InvestigationTestResult[]): Promise<void> {
    const targets = results.filter((result) => result.verdict?.category === "scenario_issue");
    for (let offset = 0; offset < targets.length; offset += TEST_CONCURRENCY) {
        const wave = targets.slice(offset, offset + TEST_CONCURRENCY);
        await Promise.all(wave.map((result) => diagnoseOne(snapshotId, result)));
    }
}

async function diagnoseOne(snapshotId: string, result: InvestigationTestResult): Promise<void> {
    const verdict = result.verdict;
    if (verdict == null) return;
    // Only a run that reached the app produces an on-screen observation (the fix_test/recipe_only signal); a
    // provisioning failure never did, so its route comes from the SDK error in `whatHappened` alone.
    const runObservation = verdict.ran ? scenarioObservation(verdict) : undefined;
    try {
        const diagnosis = await investigation.diagnoseInvestigationScenario({
            snapshotId,
            slug: result.slug,
            failureDetail: verdict.whatHappened,
            runObservation,
        });
        if (diagnosis != null) result.scenarioDiagnosis = diagnosis;
    } catch (error) {
        log.warn("Scenario diagnosis failed; continuing without a route", {
            snapshot: { snapshotId },
            extra: { slug: result.slug, message: rootFailureMessage(error) },
        });
    }
}

/** The run's on-screen account of the data mismatch: the classifier's root cause plus any observed app issues. */
function scenarioObservation(verdict: InvestigationVerdict): string {
    const parts = [verdict.rootCause, verdict.observedAppIssues].filter((part) => part != null && part !== "");
    return parts.join(" ");
}

/**
 * Autofix validation pass (recipe routes): for each result the diagnoser routed to a recipe change, run the
 * recipe-repair AGENT (it reads the client's factory code + DB schema, queries the live backend, and dry-run-seeds
 * candidates against the real factory) to produce a factory-accepted candidate, then stage that candidate on the
 * twin's recipe version (a branch-scoped write - the real run resolves the recipe by [scenarioId, snapshotId], so
 * this only affects this snapshot) and re-seed + re-run the test to prove it fixes the failure. On success the
 * validated recipe stays on the twin and the merge-with-main step carries it into a main-proposal when the PR
 * merges; on failure we revert the twin so the failed candidate is never carried. It is never activated on main
 * mid-PR - a recipe correct for this branch can be wrong for main + other branches. When the agent gives up (no
 * factory-accepted candidate), its handoff is recorded and nothing is staged. Processed sequentially so two tests
 * sharing a scenario never race on the twin's recipe version. Every step is contained: a failure records why on
 * the result and moves on, never sinking the report.
 */
async function applyRecipeRepairs(snapshotId: string, results: InvestigationTestResult[]): Promise<void> {
    const targets = results.filter((result) => {
        const route = result.scenarioDiagnosis?.route;
        return route === "recipe_only" || route === "recipe_and_sdk";
    });
    for (const result of targets) {
        await applyRecipeRepair(snapshotId, result).catch((error) => {
            const message = rootFailureMessage(error);
            log.error("Recipe repair failed; leaving the dry-run proposal", {
                snapshot: { snapshotId },
                extra: { slug: result.slug, message },
            });
            setApplied(result, false, `repair errored: ${message}`);
        });
    }
}

/**
 * Repair one scenario recipe with an OUTER loop: up to MAX_RECIPE_REPAIR_ATTEMPTS passes of {agent proposes a
 * candidate -> stage it on the twin -> re-seed + re-run the REAL test -> classify}. A pass that seeds fine but does
 * not make the test pass feeds its run account back into the next agent call, so the agent tries a materially
 * different recipe with real evidence (not just a fresh guess). The twin recipe is restored to its ORIGINAL graph
 * on give-up so no failed candidate is carried into main by the merge-with-main step; a passing candidate stays.
 */
async function applyRecipeRepair(snapshotId: string, result: InvestigationTestResult): Promise<void> {
    const diagnosis = result.scenarioDiagnosis;
    if (diagnosis == null) return;

    const priorAttempts: { createGraphJson: string; failureDetail: string }[] = [];
    // The graph to restore on give-up: the twin's recipe BEFORE the first stage (captured from the first stage's
    // pre-stage snapshot). Undefined until we stage something.
    let originalCreateGraphJson: string | undefined;
    let scenarioId: string | undefined;

    try {
        for (let attempt = 1; attempt <= MAX_RECIPE_REPAIR_ATTEMPTS; attempt++) {
            // The tool-using agent refines the diagnoser's one-shot proposal into a factory-accepted candidate (or
            // gives up). Routed through the longer-timeout proxy (its retrying model calls + dry-runs can exceed
            // the default 20m). Prior failed passes are fed back so it does not repeat a recipe that already failed.
            const proposal = await investigationRepair.proposeRecipeRepair({
                snapshotId,
                slug: result.slug,
                recipeChange: diagnosis.recipeChange ?? "",
                failureDetail: result.verdict?.whatHappened ?? "",
                priorAttempts,
            });

            if (proposal.factoryIssue != null && proposal.factoryIssue !== "")
                diagnosis.factoryIssue = proposal.factoryIssue;
            if (proposal.handoff != null && proposal.handoff !== "") diagnosis.repairHandoff = proposal.handoff;

            // recipe_and_sdk means the factory itself needs a code change: the agent's graph is one the CURRENT
            // factory rejects, so staging + re-running it can only fail. Record the escalation and stop.
            if (proposal.route === "recipe_and_sdk") {
                setApplied(result, false, "escalated to a client-factory change; not staged on the twin");
                return;
            }

            const createGraphJson = proposal.route === "recipe_only" ? proposal.createGraphJson : undefined;
            if (createGraphJson == null || createGraphJson === "") {
                // Re-routed to a test fix, or gave up: its handoff is already recorded. Nothing more to stage.
                const why =
                    proposal.route === "fix_test" ? "agent re-routed to a test fix" : "agent produced no viable recipe";
                setApplied(result, false, attempt === 1 ? why : `${why} after ${attempt - 1} failed attempt(s)`);
                return;
            }

            // Surface the candidate the report shows - it supersedes the diagnoser's one-shot graph, because this is
            // the exact recipe we stage and validate on the twin this pass.
            diagnosis.proposedRecipeCreateGraph = createGraphJson;
            if (proposal.summary != null && proposal.summary !== "") diagnosis.proposedRecipeSummary = proposal.summary;

            const outcome = await validateCandidateOnTwin(snapshotId, result, createGraphJson);
            if (!outcome.staged) {
                setApplied(result, false, "no scenario/recipe to validate the candidate against");
                return;
            }
            scenarioId = outcome.scenarioId;
            originalCreateGraphJson ??= outcome.previousCreateGraphJson;

            if (outcome.passed) {
                setApplied(
                    result,
                    true,
                    `validated on the twin (branch-scoped) on attempt ${attempt}/${MAX_RECIPE_REPAIR_ATTEMPTS}; merges into main with the PR`,
                );
                return;
            }

            // Seeded but the real test still failed: feed the run account back so the next pass tries something
            // different. The next stage overwrites the twin recipe, so no revert is needed between passes.
            priorAttempts.push({ createGraphJson, failureDetail: outcome.failureDetail });
        }
        setApplied(
            result,
            false,
            `no recipe made the test pass after ${MAX_RECIPE_REPAIR_ATTEMPTS} attempts on the twin; reverted`,
        );
    } finally {
        // Restore the ORIGINAL twin recipe unless a candidate passed (applied === true keeps the passing recipe),
        // so a failed candidate is never carried into main by the merge-with-main step.
        if (diagnosis.applied !== true && originalCreateGraphJson != null && scenarioId != null) {
            const restore = originalCreateGraphJson;
            const scenario = scenarioId;
            await CancellationScope.nonCancellable(() =>
                investigation.revertTwinRecipe({ snapshotId, scenarioId: scenario, createGraphJson: restore }),
            ).catch((error) => {
                log.error("Failed to restore the twin recipe after recipe repair; the merge step must re-check", {
                    snapshot: { snapshotId },
                    extra: { slug: result.slug, message: rootFailureMessage(error) },
                });
            });
        }
    }
}

/** The outcome of staging one candidate on the twin and re-running the real test against it. */
type TwinValidation =
    | { staged: false }
    | { staged: true; passed: boolean; scenarioId: string; previousCreateGraphJson?: string; failureDetail: string };

/**
 * Stage one candidate on the twin, re-seed (`scenarioUp`), re-run the real test, and classify it - the authoritative
 * check that this recipe makes the test pass. Always tears the scenario instance down. Does NOT revert the twin
 * recipe: the outer loop owns restoration (it overwrites between passes and restores the original on give-up).
 */
async function validateCandidateOnTwin(
    snapshotId: string,
    result: InvestigationTestResult,
    createGraphJson: string,
): Promise<TwinValidation> {
    const staged = await investigation.stageRecipeCandidateOnTwin({ snapshotId, slug: result.slug, createGraphJson });
    if (!staged.staged || staged.testGenerationId == null || staged.scenarioId == null) {
        return { staged: false };
    }
    const { testGenerationId, scenarioId, previousCreateGraphJson } = staged;

    let scenarioInstanceId: string | undefined;
    try {
        const up = await general.scenarioUp({ scenarioJobType: "generation", entityId: testGenerationId, scenarioId });
        scenarioInstanceId = up.scenarioInstanceId;
        try {
            await web.runWebGeneration({ testGenerationId });
        } catch (error) {
            log.warn("Candidate validation run errored; classifying anyway", {
                snapshot: { snapshotId },
                extra: { slug: result.slug, message: rootFailureMessage(error) },
            });
        }
        const outcome = await investigation.classifyInvestigationRun({
            snapshotId,
            slug: result.slug,
            reason: "validating a candidate recipe on the twin (branch-scoped; never activated on main)",
            testGenerationId,
        });
        return {
            staged: true,
            passed: outcome.runSuccess,
            scenarioId,
            previousCreateGraphJson,
            failureDetail: twinFailureDetail(outcome),
        };
    } finally {
        if (scenarioInstanceId != null) {
            const instanceId = scenarioInstanceId;
            await CancellationScope.nonCancellable(() => general.scenarioDown({ scenarioInstanceId: instanceId }));
        }
    }
}

/** The run's account of why the test still failed with a candidate recipe - fed back to the next repair pass. */
function twinFailureDetail(outcome: InvestigationTestResult): string {
    const verdict = outcome.verdict;
    if (verdict == null) return "the test did not pass on the twin (no verdict was produced).";
    const parts = [verdict.whatHappened, verdict.rootCause].filter((part) => part != null && part !== "");
    return parts.length > 0 ? parts.join(" ") : "the test did not pass on the twin.";
}

/**
 * Autofix validation pass (fix_test): for each result the diagnoser routed to fix_test with a concrete edited
 * plan, VALIDATE the edit on the twin (`validatePlan`: draft plan + shadow generation, re-seed, re-run, edit and
 * retry on failure). We never write to main - the validated plan is stored on the result so the persist step
 * below writes it onto the branch (twin) snapshot, and it rides the PR into main only when it merges. Processed
 * sequentially so the validation runs don't fan out beyond the wave budget. Contained: a failure never sinks the
 * report.
 */
async function applyTestFixes(snapshotId: string, results: InvestigationTestResult[]): Promise<void> {
    const targets = results.filter((result) => {
        const plan = result.verdict?.suggestedTestUpdate;
        return result.scenarioDiagnosis?.route === "fix_test" && plan != null && plan !== "";
    });
    for (const result of targets) {
        const plan = result.verdict?.suggestedTestUpdate;
        if (plan == null || plan === "") continue;
        // Reuse the shared validate->edit->retry loop; store the outcome so the persist step writes the VALIDATED
        // finalPlan (not the raw suggestion) onto the branch snapshot. Contained per-result.
        const validation = await validatePlan(snapshotId, plan, result.slug).catch((error) =>
            failedValidation(snapshotId, plan, error),
        );
        result.modificationValidation = validation;
        setApplied(
            result,
            validation.passed,
            validation.passed
                ? "validated on the twin (branch-scoped); rides the branch and merges into main with the PR"
                : `not validated on the twin: ${validation.failureReason ?? "did not pass"}`,
        );
    }
}

/** Record the autofix validation outcome on the result's diagnosis (mutated in place so the report can show it). */
function setApplied(result: InvestigationTestResult, applied: boolean, note: string): void {
    if (result.scenarioDiagnosis == null) return;
    result.scenarioDiagnosis.applied = applied;
    result.scenarioDiagnosis.appliedNote = note;
}

/**
 * Run the affected tests and validate the proposed new tests under ONE shared TEST_CONCURRENCY budget. Both are
 * web-worker + scenario-provisioning work against the client preview, so they must share the cap that bounds it -
 * two separate concurrent wave loops would double the ceiling. Proposals are scheduled first so they start in the
 * first wave rather than waiting for the whole affected set. Returns the affected-test results in slug order;
 * proposal outcomes are written back onto `suggested` in place. Every unit is contained: a single failure never
 * sinks the run.
 */
async function runTestsAndValidateProposals(
    snapshotId: string,
    tests: InvestigationSelectedTest[],
    suggested: { instruction: string; validation?: TestValidationResult }[],
    ids: { snapshot: { snapshotId: string } },
): Promise<InvestigationTestResult[]> {
    const results = new Array<InvestigationTestResult>(tests.length);
    const proposalTasks = suggested.map((proposal) => async () => {
        proposal.validation = await validatePlan(snapshotId, proposal.instruction, undefined).catch((error) =>
            failedValidation(snapshotId, proposal.instruction, error),
        );
    });
    const testTasks = tests.map((test, index) => async () => {
        results[index] = await runOneTest(snapshotId, test).catch((error) => testRunFailure(test, error, ids));
    });
    await runInBoundedWaves([...proposalTasks, ...testTasks]);
    return results;
}

/** Run tasks in bounded waves of TEST_CONCURRENCY, awaiting each wave before the next - the single choke point
 * that holds the documented ceiling on concurrent web browsers / scenario provisions across every caller. */
async function runInBoundedWaves(tasks: Array<() => Promise<void>>): Promise<void> {
    for (let offset = 0; offset < tasks.length; offset += TEST_CONCURRENCY) {
        const wave = tasks.slice(offset, offset + TEST_CONCURRENCY);
        await Promise.all(wave.map((task) => task()));
    }
}

/**
 * Turn an error that escaped run+classify into a categorized result: a provisioning failure when the message
 * matches an SDK/infra fault (so it is not buried as a null-verdict "classification error"), else an honest
 * classification_error. Never throws - a single test's failure stays contained to its own slot.
 */
function testRunFailure(
    test: InvestigationSelectedTest,
    error: unknown,
    ids: { snapshot: { snapshotId: string } },
): InvestigationTestResult {
    const message = rootFailureMessage(error);
    const infra = infraFailureResult({ slug: test.slug, message });
    if (infra != null) {
        log.warn("Investigation test hit an SDK/infra error; categorizing as a provisioning failure", {
            ...ids,
            extra: { slug: test.slug, message, category: infra.verdict?.category },
        });
        return infra;
    }
    log.error("Investigation test failed; recording as classification error and continuing", {
        ...ids,
        extra: { slug: test.slug, message },
    });
    return { slug: test.slug, plan: "", runSuccess: false, stepCount: 0, error: message };
}

/**
 * Validate every classifier-suggested MODIFICATION by running the edited plan (validate->edit->retry), sharing
 * the TEST_CONCURRENCY budget. Mutates each result in place with `modificationValidation`. Runs after the affected
 * wave because each edit is derived from that test's verdict. Rows autofix already validated (applyTestFixes sets
 * `modificationValidation` on fix_test rows for opted-in orgs) are skipped - re-running them would overwrite a
 * passing result with a fresh, possibly-flaky one and double the web-worker cost. Each validation is contained.
 */
async function validateModifications(snapshotId: string, results: InvestigationTestResult[]): Promise<void> {
    const targets = results.filter((result) => {
        const update = result.verdict?.suggestedTestUpdate;
        return update != null && update !== "" && result.modificationValidation == null;
    });
    const tasks = targets.map((result) => async () => {
        const update = result.verdict?.suggestedTestUpdate;
        if (update == null || update === "") return;
        result.modificationValidation = await validatePlan(snapshotId, update, result.slug).catch((error) =>
            failedValidation(snapshotId, update, error),
        );
    });
    await runInBoundedWaves(tasks);
}

function failedValidation(snapshotId: string, plan: string, error: unknown): TestValidationResult {
    const failureReason = rootFailureMessage(error);
    log.error("Validation loop errored; recording and continuing", {
        snapshot: { snapshotId },
        extra: { failureReason },
    });
    return { passed: false, iterations: 0, finalPlan: plan, failureReason };
}

/**
 * Run one candidate plan through the validate->edit->retry loop: create a shadow generation for it, run it on
 * the web worker, check the outcome, and on failure take the edited plan and try again, up to N iterations.
 */
async function validatePlan(
    snapshotId: string,
    plan: string,
    baseSlug: string | undefined,
): Promise<TestValidationResult> {
    let currentPlan = plan;
    for (let iteration = 1; iteration <= MAX_VALIDATION_ITERATIONS; iteration++) {
        const created = await investigation.createValidationGeneration({ snapshotId, plan: currentPlan, baseSlug });
        if (created.testGenerationId == null) {
            const failureReason = created.skippedReason ?? "could not prepare a validation run";
            return { passed: false, iterations: iteration - 1, finalPlan: currentPlan, failureReason };
        }
        const testGenerationId = created.testGenerationId;
        let scenarioInstanceId: string | undefined;
        try {
            if (created.scenarioId != null) {
                const up = await general.scenarioUp({
                    scenarioJobType: "generation",
                    entityId: testGenerationId,
                    scenarioId: created.scenarioId,
                });
                scenarioInstanceId = up.scenarioInstanceId;
            }
            try {
                await web.runWebGeneration({ testGenerationId });
            } catch (error) {
                log.warn("Validation generation errored; classifying the outcome anyway", {
                    snapshot: { snapshotId },
                    extra: { message: rootFailureMessage(error) },
                });
            }
            // Reuse the classifier as the check: it gives both the pass signal (runSuccess) and the edit
            // (suggestedTestUpdate) to try next iteration.
            const outcome = await investigation.classifyInvestigationRun({
                snapshotId,
                slug: created.slug ?? "validation-candidate",
                reason: "validating a proposed/modified plan",
                testGenerationId,
            });
            if (outcome.runSuccess) return { passed: true, iterations: iteration, finalPlan: currentPlan };
            const revisedPlan = outcome.verdict?.suggestedTestUpdate;
            if (revisedPlan == null || revisedPlan === "" || revisedPlan === currentPlan) {
                return {
                    passed: false,
                    iterations: iteration,
                    finalPlan: currentPlan,
                    failureReason: "the run failed and no further revision was produced",
                };
            }
            currentPlan = revisedPlan;
        } finally {
            if (scenarioInstanceId != null) {
                const instanceId = scenarioInstanceId;
                await CancellationScope.nonCancellable(() => general.scenarioDown({ scenarioInstanceId: instanceId }));
            }
        }
    }
    return {
        passed: false,
        iterations: MAX_VALIDATION_ITERATIONS,
        finalPlan: currentPlan,
        failureReason: `did not pass within ${MAX_VALIDATION_ITERATIONS} iterations`,
    };
}

/** Run + classify a single shadow test. A failed generation is still classified - that's the signal we want. */
async function runOneTest(snapshotId: string, test: InvestigationSelectedTest): Promise<InvestigationTestResult> {
    // Mirror the diffs generation path: if `scenario up` fails, the environment was never provisioned, so skip
    // the browser AND the classifier entirely and report a categorized provisioning failure. Running the
    // classifier here would clone + call the model against a test that never executed and, because it produces
    // no verdict, the report would mislabel the SDK error as a `classification_error`.
    if (test.scenarioId != null) {
        let scenarioInstanceId: string;
        try {
            const up = await general.scenarioUp({
                scenarioJobType: "generation",
                entityId: test.testGenerationId,
                scenarioId: test.scenarioId,
            });
            scenarioInstanceId = up.scenarioInstanceId;
        } catch (error) {
            const message = rootFailureMessage(error);
            log.warn("Scenario setup failed; skipping the run and classifier for this test", {
                snapshot: { snapshotId },
                extra: { slug: test.slug, message },
            });
            return scenarioSetupFailureResult({ slug: test.slug, message });
        }
        return await runAndClassify(snapshotId, test, scenarioInstanceId);
    }
    return await runAndClassify(snapshotId, test, undefined);
}

/** Run the shadow generation, classify the outcome, and always tear the scenario down afterwards. */
async function runAndClassify(
    snapshotId: string,
    test: InvestigationSelectedTest,
    scenarioInstanceId: string | undefined,
): Promise<InvestigationTestResult> {
    try {
        try {
            await web.runWebGeneration({ testGenerationId: test.testGenerationId });
        } catch (error) {
            log.warn("Shadow generation errored; classifying the failed run anyway", {
                snapshot: { snapshotId },
                extra: { slug: test.slug, message: rootFailureMessage(error) },
            });
        }

        return await investigation.classifyInvestigationRun({
            snapshotId,
            slug: test.slug,
            reason: test.reason,
            testGenerationId: test.testGenerationId,
        });
    } finally {
        // Never let a teardown error throw out of the finally: it would replace the classified verdict this
        // function just produced and surface as a null-verdict "classification error" (a common SDK-down mislabel).
        if (scenarioInstanceId != null) {
            const instanceId = scenarioInstanceId;
            await CancellationScope.nonCancellable(() =>
                general.scenarioDown({ scenarioInstanceId: instanceId }),
            ).catch((error) => {
                log.warn("Scenario teardown failed after classify; keeping the verdict", {
                    snapshot: { snapshotId },
                    extra: { slug: test.slug, message: rootFailureMessage(error) },
                });
            });
        }
    }
}
