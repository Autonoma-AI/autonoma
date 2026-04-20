import type { BillingService } from "@autonoma/billing";
import type { ApplicationArchitecture, PrismaClient } from "@autonoma/db";
import type { Logger } from "@autonoma/logger";
import { logger as rootLogger } from "@autonoma/logger";

export interface PrepareRunsParams {
    db: PrismaClient;
    snapshotId: string;
    applicationId: string;
    organizationId: string;
    billingService: BillingService;
}

export interface PreparedRunResult {
    runId: string;
    slug: string;
    architecture: ApplicationArchitecture;
    scenarioId?: string;
}

export async function prepareRuns(slugs: string[], params: PrepareRunsParams): Promise<PreparedRunResult[]> {
    const logger = rootLogger.child({ name: "prepareRuns", snapshotId: params.snapshotId });
    logger.info("Preparing runs for affected tests", { slugs, count: slugs.length });

    const { db, snapshotId, applicationId, organizationId, billingService } = params;

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

    // 2. Find the assignment (scoped to this snapshot) for each test
    interface InternalPreparedRun {
        slug: string;
        testCaseName: string;
        assignmentId: string;
        architecture: ApplicationArchitecture;
        scenarioId?: string;
    }

    const preparedRuns: InternalPreparedRun[] = [];

    for (const slug of slugs) {
        const testCase = testCaseBySlug.get(slug);
        if (testCase == null) {
            logger.warn("Test case not found for slug", { slug, applicationId });
            continue;
        }

        const assignment = await findAssignmentWithSteps(db, snapshotId, testCase.id, slug, logger);
        if (assignment == null) continue;

        preparedRuns.push({
            slug,
            testCaseName: testCase.name,
            assignmentId: assignment.id,
            architecture: testCase.application.architecture,
            scenarioId: assignment.scenarioId,
        });
    }

    if (preparedRuns.length === 0) {
        logger.info("No runnable tests found");
        return [];
    }

    // 3. Check billing for all runs at once
    const sampleArchitecture = preparedRuns[0]!.architecture;
    try {
        await billingService.checkCreditsGate(organizationId, preparedRuns.length, sampleArchitecture, "run");
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
    snapshotId: string,
    testCaseId: string,
    slug: string,
    logger: Logger,
): Promise<{ id: string; scenarioId?: string } | undefined> {
    const assignment = await db.testCaseAssignment.findUnique({
        where: { snapshotId_testCaseId: { snapshotId, testCaseId } },
        select: { id: true, stepsId: true, plan: { select: { scenarioId: true } } },
    });

    if (assignment == null) {
        logger.warn("Test case has no assignment in this snapshot; skipping run", {
            snapshotId,
            testCaseId,
            slug,
        });
        return;
    }

    if (assignment.stepsId == null) {
        logger.warn("Test case assignment has no steps; skipping run", {
            snapshotId,
            testCaseId,
            slug,
            assignmentId: assignment.id,
        });
        return;
    }

    return {
        id: assignment.id,
        scenarioId: assignment.plan?.scenarioId ?? undefined,
    };
}
