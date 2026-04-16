import type { BillingService } from "@autonoma/billing";
import type { PrismaClient } from "@autonoma/db";
import type { Logger } from "@autonoma/logger";
import { logger as rootLogger } from "@autonoma/logger";

const architectureMap: Record<string, string> = {
    WEB: "web",
    IOS: "ios",
    ANDROID: "android",
};

export interface PrepareRunsParams {
    db: PrismaClient;
    applicationId: string;
    organizationId: string;
    billingService: BillingService;
}

export interface PreparedRunResult {
    runId: string;
    slug: string;
    architecture: string;
    scenarioId?: string;
}

export async function prepareRuns(slugs: string[], params: PrepareRunsParams): Promise<PreparedRunResult[]> {
    const logger = rootLogger.child({ name: "prepareRuns" });
    logger.info("Preparing runs for affected tests", { slugs, count: slugs.length });

    const { db, applicationId, organizationId, billingService } = params;

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

    // 2. Find assignments with steps for each test
    interface InternalPreparedRun {
        slug: string;
        testCaseName: string;
        assignmentId: string;
        dbArchitecture: string;
        architecture: string;
        scenarioId?: string;
    }

    const preparedRuns: InternalPreparedRun[] = [];

    for (const slug of slugs) {
        const testCase = testCaseBySlug.get(slug);
        if (testCase == null) {
            logger.warn("Test case not found for slug", { slug, applicationId });
            continue;
        }

        const assignment = await findAssignmentWithSteps(db, testCase.id, organizationId, logger);
        if (assignment == null) {
            logger.warn("No runnable assignment found for test", { slug, testCaseId: testCase.id });
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
        logger.info("No runnable tests found");
        return [];
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
        return [];
    }

    // 4. Create Run records and deduct credits
    const results: PreparedRunResult[] = [];

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
            continue;
        }

        results.push({
            runId: run.id,
            slug: prepared.slug,
            architecture: prepared.architecture,
            scenarioId: prepared.scenarioId,
        });
    }

    logger.info("Runs prepared", { total: slugs.length, prepared: results.length });
    return results;
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
