import type { BillingService } from "@autonoma/billing";
import type { ApplicationArchitecture, PrismaClient } from "@autonoma/db";
import type { Logger } from "@autonoma/logger";
import { logger as rootLogger } from "@autonoma/logger";
import type { AffectedReason } from "../tools/mark-affected-test-tool";

export interface PrepareRunsParams {
    db: PrismaClient;
    snapshotId: string;
    applicationId: string;
    organizationId: string;
    billingService: BillingService;
}

export interface AffectedTestSpec {
    slug: string;
    affectedReason: AffectedReason;
    reasoning: string;
}

export interface PreparedRunResult {
    runId: string;
    slug: string;
    architecture: ApplicationArchitecture;
    scenarioId?: string;
}

/**
 * Creates a Run record (and matching AffectedTest row) for each affected test
 * whose slug resolves to a runnable assignment in the snapshot. Slugs without
 * a corresponding test case, without a runnable assignment, or whose billing
 * check fails are skipped silently.
 */
export async function prepareRuns(
    affectedTests: AffectedTestSpec[],
    params: PrepareRunsParams,
): Promise<PreparedRunResult[]> {
    const logger = rootLogger.child({ name: "prepareRuns", snapshotId: params.snapshotId });
    logger.info("Preparing runs for affected tests", { count: affectedTests.length });

    const { db, snapshotId, applicationId, organizationId, billingService } = params;
    const slugs = affectedTests.map((t) => t.slug);

    const testCases = await db.testCase.findMany({
        where: { slug: { in: slugs }, applicationId },
        select: {
            id: true,
            name: true,
            slug: true,
            application: { select: { architecture: true } },
            assignments: {
                where: { snapshotId },
                select: { quarantineIssueId: true },
            },
        },
    });

    const testCaseBySlug = new Map(testCases.map((tc) => [tc.slug, tc]));

    interface InternalPreparedRun {
        slug: string;
        testCaseId: string;
        testCaseName: string;
        assignmentId: string;
        planId?: string;
        architecture: ApplicationArchitecture;
        scenarioId?: string;
        affectedReason: AffectedReason;
        reasoning: string;
    }

    const preparedRuns: InternalPreparedRun[] = [];

    for (const affected of affectedTests) {
        const testCase = testCaseBySlug.get(affected.slug);
        if (testCase == null) {
            logger.warn("Test case not found for slug", { slug: affected.slug, applicationId });
            continue;
        }

        if (testCase.assignments[0]?.quarantineIssueId != null) {
            logger.warn("Skipping run for quarantined test", {
                slug: affected.slug,
                testCaseId: testCase.id,
                snapshotId,
            });
            continue;
        }

        const assignment = await findAssignmentWithSteps(db, snapshotId, testCase.id, affected.slug, logger);
        if (assignment == null) continue;

        preparedRuns.push({
            slug: affected.slug,
            testCaseId: testCase.id,
            testCaseName: testCase.name,
            assignmentId: assignment.id,
            planId: assignment.planId,
            architecture: testCase.application.architecture,
            scenarioId: assignment.scenarioId,
            affectedReason: affected.affectedReason,
            reasoning: affected.reasoning,
        });
    }

    if (preparedRuns.length === 0) {
        logger.info("No runnable tests found");
        return [];
    }

    // Check billing for all runs at once
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

    // Create Run records, deduct credits, and persist AffectedTest rows
    const results: PreparedRunResult[] = [];

    for (const prepared of preparedRuns) {
        const run = await db.run.create({
            data: {
                assignmentId: prepared.assignmentId,
                organizationId,
                status: "pending",
                planId: prepared.planId,
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

        await db.affectedTest.upsert({
            where: { snapshotId_testCaseId: { snapshotId, testCaseId: prepared.testCaseId } },
            create: {
                snapshotId,
                testCaseId: prepared.testCaseId,
                organizationId,
                affectedReason: prepared.affectedReason,
                reasoning: prepared.reasoning,
                runId: run.id,
            },
            update: {
                affectedReason: prepared.affectedReason,
                reasoning: prepared.reasoning,
                runId: run.id,
            },
        });

        results.push({
            runId: run.id,
            slug: prepared.slug,
            architecture: prepared.architecture,
            scenarioId: prepared.scenarioId,
        });
    }

    logger.info("Runs prepared", { total: affectedTests.length, prepared: results.length });
    return results;
}

async function findAssignmentWithSteps(
    db: PrismaClient,
    snapshotId: string,
    testCaseId: string,
    slug: string,
    logger: Logger,
): Promise<{ id: string; planId?: string; scenarioId?: string } | undefined> {
    const assignment = await db.testCaseAssignment.findUnique({
        where: { snapshotId_testCaseId: { snapshotId, testCaseId } },
        select: { id: true, stepsId: true, planId: true, plan: { select: { scenarioId: true } } },
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
        planId: assignment.planId ?? undefined,
        scenarioId: assignment.plan?.scenarioId ?? undefined,
    };
}
