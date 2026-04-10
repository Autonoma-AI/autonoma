import type { BillingService } from "@autonoma/billing";
import type { PrismaClient } from "@autonoma/db";
import type { Logger } from "@autonoma/logger";
import { logger as rootLogger } from "@autonoma/logger";
import type { TestRunResult } from "../diffs-agent";

const POLL_INTERVAL_MS = 5_000;
const STARTUP_TIMEOUT_MS = 2 * 60 * 1_000;
const STALL_TIMEOUT_MS = 60 * 1_000;

const architectureMap: Record<string, string> = {
    WEB: "web",
    IOS: "ios",
    ANDROID: "android",
};

export type TriggerRunWorkflowFn = (params: {
    runId: string;
    architecture: string;
    agentVersion: string;
    scenarioId?: string;
}) => Promise<void>;

export interface TriggerTestsParams {
    db: PrismaClient;
    applicationId: string;
    organizationId: string;
    agentVersion: string;
    billingService: BillingService;
    triggerRunWorkflow: TriggerRunWorkflowFn;
}

interface PreparedRun {
    slug: string;
    testCaseName: string;
    assignmentId: string;
    dbArchitecture: string;
    architecture: string;
    scenarioId?: string;
}

interface TrackedRun {
    runId: string;
    slug: string;
    testCaseName: string;
    createdAt: number;
}

export async function triggerTestsAndWait(slugs: string[], params: TriggerTestsParams): Promise<TestRunResult[]> {
    const logger = rootLogger.child({ name: "triggerTestsAndWait" });
    logger.info("Starting batch test execution", { slugs, count: slugs.length });

    const { db, applicationId, organizationId, agentVersion, billingService, triggerRunWorkflow } = params;

    // 1. Look up test cases by slug
    const testCases = await db.testCase.findMany({
        where: { slug: { in: slugs }, applicationId },
        select: {
            id: true,
            name: true,
            slug: true,
            application: { select: { architecture: true } },
        },
    });

    const testCaseBySlug = new Map(testCases.map((tc) => [tc.slug, tc]));

    // 2. Prepare runs - find assignments, handle missing slugs
    const preparedRuns: PreparedRun[] = [];
    const earlyFailures: TestRunResult[] = [];

    for (const slug of slugs) {
        const testCase = testCaseBySlug.get(slug);
        if (testCase == null) {
            logger.warn("Test case not found for slug", { slug, applicationId });
            earlyFailures.push(
                buildErrorResult(
                    slug,
                    slug,
                    `Test case not found for slug "${slug}". This slug does not exist in the database for this application.`,
                ),
            );
            continue;
        }

        const assignment = await findAssignmentWithSteps(db, testCase.id, organizationId, logger);
        if (assignment == null) {
            logger.warn("No runnable assignment found for test", { slug, testCaseId: testCase.id });
            earlyFailures.push(
                buildErrorResult(slug, testCase.name, `No runnable assignment with steps found for test: ${slug}`),
            );
            continue;
        }

        const architecture = architectureMap[testCase.application.architecture] ?? "web";
        preparedRuns.push({
            slug,
            testCaseName: testCase.name,
            assignmentId: assignment.id,
            dbArchitecture: testCase.application.architecture,
            architecture,
            scenarioId: assignment.scenarioId,
        });
    }

    if (preparedRuns.length === 0) {
        logger.info("No runnable tests found, returning early failures", { earlyFailureCount: earlyFailures.length });
        return earlyFailures;
    }

    // 3. Check billing for all runs at once
    const sampleDbArchitecture = preparedRuns[0]!.dbArchitecture;
    try {
        await billingService.checkCreditsGate(
            organizationId,
            preparedRuns.length,
            sampleDbArchitecture as "WEB" | "IOS" | "ANDROID",
            "run",
        );
    } catch (error) {
        logger.error("Billing credits check failed for batch", error, {
            organizationId,
            runCount: preparedRuns.length,
        });
        return [
            ...earlyFailures,
            ...preparedRuns.map((r) => buildErrorResult(r.slug, r.testCaseName, "Insufficient billing credits")),
        ];
    }

    // 4. Create Run records and trigger workflows
    const trackedRuns: TrackedRun[] = [];
    const now = Date.now();

    for (const prepared of preparedRuns) {
        const run = await db.run.create({
            data: {
                assignmentId: prepared.assignmentId,
                organizationId,
                status: "pending",
            },
            select: { id: true },
        });

        logger.info("Run record created", { runId: run.id, slug: prepared.slug, assignmentId: prepared.assignmentId });

        try {
            await billingService.deductCreditsForRun(run.id);
        } catch (error) {
            logger.error("Failed to deduct credits for run", error, { runId: run.id, slug: prepared.slug });
            await db.run.update({ where: { id: run.id }, data: { status: "failed" } });
            earlyFailures.push(
                buildErrorResult(prepared.slug, prepared.testCaseName, "Failed to deduct billing credits"),
            );
            continue;
        }

        try {
            await triggerRunWorkflow({
                runId: run.id,
                architecture: prepared.architecture,
                agentVersion,
                scenarioId: prepared.scenarioId,
            });
            logger.info("Workflow triggered for run", { runId: run.id, slug: prepared.slug });
        } catch (error) {
            logger.error("Failed to trigger run workflow", error, { runId: run.id, slug: prepared.slug });
            await db.run.update({
                where: { id: run.id },
                data: { status: "failed", reasoning: `Workflow trigger failed: ${String(error)}` },
            });
            earlyFailures.push(
                buildErrorResult(prepared.slug, prepared.testCaseName, `Failed to trigger test execution workflow`),
            );
            continue;
        }

        trackedRuns.push({
            runId: run.id,
            slug: prepared.slug,
            testCaseName: prepared.testCaseName,
            createdAt: now,
        });
    }

    if (trackedRuns.length === 0) {
        logger.info("No runs were successfully triggered, returning early failures", {
            earlyFailureCount: earlyFailures.length,
        });
        return earlyFailures;
    }

    // 5. Poll for completion
    logger.info("Polling for run completion", {
        trackedRunCount: trackedRuns.length,
        runIds: trackedRuns.map((r) => r.runId),
    });

    const completedRunIds = await pollRunsToCompletion(db, trackedRuns, logger);

    // 6. Map results
    const results = await mapRunsToResults(db, trackedRuns, logger);

    logger.info("Batch test execution complete", {
        total: slugs.length,
        completed: completedRunIds.size,
        earlyFailures: earlyFailures.length,
    });

    return [...earlyFailures, ...results];
}

async function pollRunsToCompletion(db: PrismaClient, trackedRuns: TrackedRun[], logger: Logger): Promise<Set<string>> {
    const completedRunIds = new Set<string>();
    const failedRunIds = new Set<string>();
    const runIds = trackedRuns.map((r) => r.runId);
    const runMap = new Map(trackedRuns.map((r) => [r.runId, r]));

    while (completedRunIds.size + failedRunIds.size < trackedRuns.length) {
        await sleep(POLL_INTERVAL_MS);

        const activeRunIds = runIds.filter((id) => !completedRunIds.has(id) && !failedRunIds.has(id));

        const runs = await db.run.findMany({
            where: { id: { in: activeRunIds } },
            select: {
                id: true,
                status: true,
                startedAt: true,
                outputs: {
                    select: {
                        list: {
                            orderBy: { createdAt: "desc" },
                            take: 1,
                            select: { createdAt: true },
                        },
                    },
                },
            },
        });

        const statusCounts = { pending: 0, running: 0, completed: 0, failed: 0 };

        for (const run of runs) {
            const tracked = runMap.get(run.id)!;
            const elapsed = Date.now() - tracked.createdAt;

            if (run.status === "success" || run.status === "failed") {
                if (run.status === "success") {
                    completedRunIds.add(run.id);
                    statusCounts.completed++;
                } else {
                    failedRunIds.add(run.id);
                    statusCounts.failed++;
                }
                logger.info("Run reached terminal state", {
                    runId: run.id,
                    slug: tracked.slug,
                    status: run.status,
                    elapsed: `${Math.round(elapsed / 1000)}s`,
                });
                continue;
            }

            if (run.status === "pending") {
                statusCounts.pending++;
                if (elapsed > STARTUP_TIMEOUT_MS) {
                    logger.error("Run failed to start within startup timeout", undefined, {
                        runId: run.id,
                        slug: tracked.slug,
                        elapsed: `${Math.round(elapsed / 1000)}s`,
                        status: "pending",
                    });
                    await db.run.update({
                        where: { id: run.id },
                        data: {
                            status: "failed",
                            reasoning: `Run failed to start within ${STARTUP_TIMEOUT_MS / 1000}s - possible infrastructure issue`,
                        },
                    });
                    failedRunIds.add(run.id);
                }
                continue;
            }

            // status === "running"
            statusCounts.running++;
            const lastStepAt = run.outputs?.list[0]?.createdAt;
            if (lastStepAt != null) {
                const timeSinceLastStep = Date.now() - lastStepAt.getTime();
                if (timeSinceLastStep > STALL_TIMEOUT_MS) {
                    logger.error("Run stalled - no step output progress", undefined, {
                        runId: run.id,
                        slug: tracked.slug,
                        lastStepAt: lastStepAt.toISOString(),
                        timeSinceLastStep: `${Math.round(timeSinceLastStep / 1000)}s`,
                    });
                    await db.run.update({
                        where: { id: run.id },
                        data: {
                            status: "failed",
                            reasoning: `Run stalled - no step output for ${Math.round(timeSinceLastStep / 1000)}s`,
                        },
                    });
                    failedRunIds.add(run.id);
                }
            } else if (elapsed > STARTUP_TIMEOUT_MS) {
                // Running but no steps at all and past startup timeout
                logger.error("Run is running but has produced no steps within timeout", undefined, {
                    runId: run.id,
                    slug: tracked.slug,
                    elapsed: `${Math.round(elapsed / 1000)}s`,
                });
                await db.run.update({
                    where: { id: run.id },
                    data: {
                        status: "failed",
                        reasoning: `Run is running but produced no steps within ${STARTUP_TIMEOUT_MS / 1000}s`,
                    },
                });
                failedRunIds.add(run.id);
            }
        }

        logger.info("Poll iteration", {
            ...statusCounts,
            totalTracked: trackedRuns.length,
            done: completedRunIds.size + failedRunIds.size,
        });
    }

    return completedRunIds;
}

async function mapRunsToResults(db: PrismaClient, trackedRuns: TrackedRun[], logger: Logger): Promise<TestRunResult[]> {
    const runIds = trackedRuns.map((r) => r.runId);
    const runMap = new Map(trackedRuns.map((r) => [r.runId, r]));

    const runs = await db.run.findMany({
        where: { id: { in: runIds } },
        select: {
            id: true,
            status: true,
            reasoning: true,
            outputs: {
                select: {
                    list: {
                        orderBy: { order: "asc" },
                        select: {
                            output: true,
                            screenshotAfter: true,
                        },
                    },
                },
            },
        },
    });

    return runs.map((run) => {
        const tracked = runMap.get(run.id)!;
        const steps = run.outputs?.list ?? [];

        const stepDescriptions = steps
            .map((step) => {
                const output = step.output as Record<string, unknown> | null;
                return (output?.outcome as string) ?? (output?.description as string) ?? "";
            })
            .filter((d) => d.length > 0);

        const screenshotUrls = steps.map((step) => step.screenshotAfter).filter((url): url is string => url != null);

        logger.info("Mapped run result", {
            runId: run.id,
            slug: tracked.slug,
            status: run.status,
            stepCount: steps.length,
        });

        return {
            slug: tracked.slug,
            testName: tracked.testCaseName,
            success: run.status === "success",
            finishReason: run.status === "success" ? ("success" as const) : ("error" as const),
            reasoning: run.reasoning ?? undefined,
            stepDescriptions,
            screenshotUrls,
        };
    });
}

async function findAssignmentWithSteps(
    db: PrismaClient,
    testCaseId: string,
    organizationId: string,
    logger: Logger,
): Promise<{ id: string; scenarioId?: string } | undefined> {
    // Prefer assignment that already has stepsId set
    const assignmentWithSteps = await db.testCaseAssignment.findFirst({
        where: {
            testCaseId,
            testCase: { organizationId },
            stepsId: { not: null },
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, plan: { select: { scenarioId: true } } },
    });

    if (assignmentWithSteps != null) {
        return {
            id: assignmentWithSteps.id,
            scenarioId: assignmentWithSteps.plan?.scenarioId ?? undefined,
        };
    }

    // Fall back: find a successful generation with steps and link it to the assignment
    const latestGeneration = await db.testGeneration.findFirst({
        where: {
            organizationId,
            status: "success",
            stepsId: { not: null },
            testPlan: { testCaseId },
        },
        orderBy: { createdAt: "desc" },
        select: { stepsId: true, testPlan: { select: { testCaseId: true, scenarioId: true } } },
    });

    if (latestGeneration?.stepsId == null) {
        logger.info("No generation with steps found for test case", { testCaseId });
        return;
    }

    const assignment = await db.testCaseAssignment.findFirst({
        where: { testCaseId, testCase: { organizationId } },
        orderBy: { createdAt: "desc" },
        select: { id: true, plan: { select: { scenarioId: true } } },
    });

    if (assignment == null) {
        logger.info("No assignment found for test case", { testCaseId });
        return;
    }

    await db.testCaseAssignment.update({
        where: { id: assignment.id },
        data: { stepsId: latestGeneration.stepsId },
    });

    return {
        id: assignment.id,
        scenarioId: assignment.plan?.scenarioId ?? latestGeneration.testPlan.scenarioId ?? undefined,
    };
}

function buildErrorResult(slug: string, testName: string, reasoning: string): TestRunResult {
    return {
        slug,
        testName,
        success: false,
        finishReason: "error",
        reasoning,
        stepDescriptions: [],
        screenshotUrls: [],
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
