import { CancellationScope, log, proxyActivities } from "@temporalio/workflow";
import type {
    GeneralActivities,
    InvestigationActivities,
    InvestigationSelectedTest,
    InvestigationTestResult,
    TestValidationResult,
    WebActivities,
} from "../activities";
import { rootFailureMessage } from "../root-failure-message";
import { TaskQueue } from "../task-queues";

/** Max validate->edit->retry passes for a single proposed/modified plan before giving up. */
const MAX_VALIDATION_ITERATIONS = 3;

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
    /**
     * When true, every proposed new test and every suggested modification is VALIDATED by running it as a
     * shadow generation (validate->edit->retry). Off by default - it needs the web worker and creates shadow
     * rows, so it stays opt-in until that infra + a shadow-row marker are in place.
     */
    validateProposals?: boolean;
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

    const selection = await investigation.selectInvestigationTests({ snapshotId });
    log.info("Investigation selected tests", { ...ids, extra: { count: selection.tests.length } });

    // Fan tests out in bounded waves (TEST_CONCURRENCY at a time) instead of one-at-a-time, preserving order.
    // A single test's failure is contained to its own slot - the workflow always proceeds to write the report.
    const results: InvestigationTestResult[] = [];
    for (let offset = 0; offset < selection.tests.length; offset += TEST_CONCURRENCY) {
        const wave = selection.tests.slice(offset, offset + TEST_CONCURRENCY);
        const settled = await Promise.all(
            wave.map((test) =>
                runOneTest(snapshotId, test).catch((error) => {
                    const message = rootFailureMessage(error);
                    log.error("Investigation test failed; recording and continuing", {
                        ...ids,
                        extra: { slug: test.slug, message },
                    });
                    const failed: InvestigationTestResult = {
                        slug: test.slug,
                        plan: "",
                        runSuccess: false,
                        stepCount: 0,
                        error: message,
                    };
                    return failed;
                }),
            ),
        );
        results.push(...settled);
    }

    if (input.validateProposals === true) {
        await validateProposals(snapshotId, selection.suggested, results);
    }

    const report = await investigation.writeInvestigationReport({
        snapshotId,
        results,
        suggested: selection.suggested,
        quarantine: selection.quarantine,
    });
    log.info("Investigation workflow completed", { ...ids, extra: { reportUrl: report.reportUrl } });
}

/**
 * Validate every proposed new test and every suggested modification by actually running it, editing the plan
 * and retrying on failure. Mutates the passed `suggested` / `results` in place with the validation outcome.
 * Each validation is contained - a failure never sinks the report.
 */
async function validateProposals(
    snapshotId: string,
    suggested: { instruction: string; validation?: TestValidationResult }[],
    results: InvestigationTestResult[],
): Promise<void> {
    for (const proposal of suggested) {
        proposal.validation = await validatePlan(snapshotId, proposal.instruction, undefined).catch((error) =>
            failedValidation(snapshotId, proposal.instruction, error),
        );
    }
    for (const result of results) {
        const update = result.verdict?.suggestedTestUpdate;
        if (update == null || update === "") continue;
        result.modificationValidation = await validatePlan(snapshotId, update, result.slug).catch((error) =>
            failedValidation(snapshotId, update, error),
        );
    }
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
    let scenarioInstanceId: string | undefined;
    try {
        if (test.scenarioId != null) {
            const up = await general.scenarioUp({
                scenarioJobType: "generation",
                entityId: test.testGenerationId,
                scenarioId: test.scenarioId,
            });
            scenarioInstanceId = up.scenarioInstanceId;
        }

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
        if (scenarioInstanceId != null) {
            const instanceId = scenarioInstanceId;
            await CancellationScope.nonCancellable(() => general.scenarioDown({ scenarioInstanceId: instanceId }));
        }
    }
}
