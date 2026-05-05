import type { BillingService } from "@autonoma/billing";
import type { PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import type { StorageProvider } from "@autonoma/storage";
import { Architecture } from "@autonoma/types";
import { type TriggerRunWorkflowParams, type WorkflowRef, findLatestWorkflowByRunId } from "@autonoma/workflow";
import { Service } from "../service";

function computeDuration(startedAt: Date | null, completedAt: Date | null): string | null {
    if (startedAt == null || completedAt == null) return null;
    const ms = completedAt.getTime() - startedAt.getTime();
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes === 0) return `${seconds}s`;
    return `${minutes}m ${seconds}s`;
}

const architectureToTypes: Record<string, Architecture> = {
    WEB: Architecture.web,
    IOS: Architecture.ios,
    ANDROID: Architecture.android,
};

type WorkflowTrigger = (params: TriggerRunWorkflowParams) => Promise<void>;

export class RunsService extends Service {
    constructor(
        private readonly db: PrismaClient,
        private readonly storageProvider: StorageProvider,
        private readonly triggerRunWorkflow: WorkflowTrigger,
        private readonly billingService: BillingService,
    ) {
        super();
    }

    async triggerRun(testCaseId: string, organizationId: string) {
        this.logger.info("Triggering run", { testCaseId, organizationId });

        const testCase = await this.db.testCase.findFirst({
            where: { id: testCaseId, organizationId },
            select: {
                id: true,
                application: { select: { architecture: true } },
            },
        });
        if (testCase == null) throw new NotFoundError("Test case not found");

        const assignment = await this.findAssignmentWithSteps(testCaseId, organizationId);
        if (assignment == null)
            throw new NotFoundError("No test case assignment with steps found - run a test generation first");

        await this.billingService.checkCreditsGate(organizationId, 1, testCase.application.architecture, "run");

        const run = await this.db.run.create({
            data: {
                assignmentId: assignment.id,
                organizationId,
                status: "pending",
            },
            select: { id: true },
        });

        try {
            await this.billingService.deductCreditsForRun(run.id);
        } catch (error) {
            this.logger.error("Failed to deduct credits for run", error, {
                runId: run.id,
                organizationId,
                target: "run",
                testCaseId,
                architecture: testCase.application.architecture,
            });
            await this.db.run.update({
                where: { id: run.id },
                data: { status: "failed" },
            });
            throw error;
        }

        const architecture = architectureToTypes[testCase.application.architecture] ?? Architecture.web;
        const scenarioId = assignment.plan?.scenarioId ?? undefined;

        this.logger.info("Run created, triggering workflow", {
            runId: run.id,
            assignmentId: assignment.id,
            architecture,
            scenarioId,
        });

        try {
            await this.triggerRunWorkflow({
                runId: run.id,
                architecture,
                scenarioId,
            });
        } catch (error) {
            this.logger.fatal("Failed to trigger run workflow", error, { runId: run.id });
            await this.db.run.update({
                where: { id: run.id },
                data: { status: "failed" },
            });
            throw error;
        }

        this.logger.info("Run triggered successfully", { runId: run.id });
        return { runId: run.id };
    }

    async getRunDetail(runId: string, organizationId: string) {
        this.logger.info("Getting run detail", { runId, organizationId });

        const run = await this.db.run.findFirst({
            where: {
                id: runId,
                assignment: {
                    testCase: { application: { organizationId } },
                },
            },
            include: {
                assignment: {
                    include: {
                        testCase: {
                            include: { tags: { include: { tag: true } } },
                        },
                    },
                },
                outputs: {
                    include: {
                        list: {
                            include: {
                                stepInput: {
                                    select: { interaction: true, params: true },
                                },
                            },
                            orderBy: { order: "asc" },
                        },
                    },
                },
                runReview: {
                    select: {
                        id: true,
                        status: true,
                        issue: { select: { id: true, severity: true, title: true } },
                    },
                },
            },
        });

        if (run == null) return null;

        const outputSteps = run.outputs?.list ?? [];

        this.logger.info("Run detail retrieved", { runId, stepCount: outputSteps.length });

        const temporalWorkflowPromise: Promise<WorkflowRef | undefined> = findLatestWorkflowByRunId(run.id).catch(
            (error) => {
                this.logger.warn("Could not resolve Temporal workflow for run", { runId: run.id, error });
                return undefined;
            },
        );

        const [steps, temporalWorkflow] = await Promise.all([
            Promise.all(
                outputSteps.map(async (step) => ({
                    id: step.id,
                    order: step.order,
                    output: step.output,
                    interaction: step.stepInput.interaction,
                    params: step.stepInput.params,
                    screenshotBefore: await (step.screenshotBefore &&
                        this.storageProvider.getSignedUrl(step.screenshotBefore, 3600)),
                    screenshotAfter: await (step.screenshotAfter &&
                        this.storageProvider.getSignedUrl(step.screenshotAfter, 3600)),
                })),
            ),
            temporalWorkflowPromise,
        ]);

        return {
            id: run.id,
            shortId: run.id.slice(0, 8),
            status: run.status,
            name: run.assignment.testCase.name,
            testCaseId: run.assignment.testCase.id,
            testCaseSlug: run.assignment.testCase.slug,
            tags: run.assignment.testCase.tags.map((tt) => tt.tag.name),
            startedAt: run.startedAt?.toISOString() ?? null,
            duration: computeDuration(run.startedAt, run.completedAt),
            reasoning: run.reasoning ?? null,
            temporalWorkflow,
            steps,
            review:
                run.runReview != null
                    ? {
                          status: run.runReview.status,
                          issue:
                              run.runReview.issue != null
                                  ? {
                                        id: run.runReview.issue.id,
                                        severity: run.runReview.issue.severity,
                                        title: run.runReview.issue.title,
                                    }
                                  : undefined,
                      }
                    : undefined,
        };
    }

    async listRuns(organizationId: string, applicationId?: string, snapshotId?: string) {
        this.logger.info("Listing runs", { organizationId, applicationId, snapshotId });

        const runs = await this.db.run.findMany({
            where: {
                assignment: {
                    ...(snapshotId != null ? { snapshotId } : {}),
                    testCase: {
                        application: { organizationId },
                        ...(applicationId != null ? { applicationId } : {}),
                    },
                },
            },
            include: {
                assignment: {
                    include: {
                        testCase: {
                            include: { tags: { include: { tag: true } } },
                        },
                    },
                },
                outputs: {
                    include: {
                        _count: { select: { list: true } },
                        list: {
                            orderBy: { order: "desc" },
                            take: 1,
                            select: { screenshotAfter: true, screenshotBefore: true },
                        },
                    },
                },
            },
            orderBy: { createdAt: "desc" },
        });

        this.logger.info("Runs listed", { count: runs.length });

        return Promise.all(
            runs.map(async (run) => {
                const lastStep = run.outputs?.list[0];
                const screenshotPath = lastStep?.screenshotAfter ?? lastStep?.screenshotBefore ?? null;
                const lastScreenshot =
                    screenshotPath != null ? await this.storageProvider.getSignedUrl(screenshotPath, 3600) : null;

                return {
                    id: run.id,
                    shortId: run.id.slice(0, 8),
                    status: run.status,
                    name: run.assignment.testCase.name,
                    tags: run.assignment.testCase.tags.map((tt) => tt.tag.name),
                    startedAt: run.startedAt ?? null,
                    duration: computeDuration(run.startedAt, run.completedAt),
                    stepCount: run.outputs?._count.list ?? 0,
                    lastScreenshot,
                };
            }),
        );
    }

    async restartRun(runId: string, organizationId: string) {
        this.logger.info("Restarting run", { runId, organizationId });

        const run = await this.db.run.findFirst({
            where: { id: runId, organizationId },
            select: {
                assignmentId: true,
                assignment: {
                    select: {
                        plan: { select: { scenarioId: true } },
                        testCase: {
                            select: { application: { select: { architecture: true } } },
                        },
                    },
                },
            },
        });
        if (run == null) throw new NotFoundError("Run not found");

        const newRun = await this.db.run.create({
            data: {
                assignmentId: run.assignmentId,
                organizationId,
                status: "pending",
            },
            select: { id: true },
        });

        const architecture = architectureToTypes[run.assignment.testCase.application.architecture] ?? Architecture.web;
        const scenarioId = run.assignment.plan?.scenarioId ?? undefined;

        this.logger.info("New run created, triggering workflow", {
            sourceRunId: runId,
            newRunId: newRun.id,
            architecture,
            scenarioId,
        });

        try {
            await this.triggerRunWorkflow({
                runId: newRun.id,
                architecture,
                scenarioId,
            });
        } catch (error) {
            this.logger.fatal("Failed to restart run workflow", error, { newRunId: newRun.id });
            await this.db.run.update({
                where: { id: newRun.id },
                data: { status: "failed" },
            });
            throw error;
        }

        this.logger.info("Run restarted successfully", { sourceRunId: runId, newRunId: newRun.id });
        return { runId: newRun.id };
    }

    async deleteRun(runId: string, organizationId: string) {
        this.logger.info("Deleting run", { runId, organizationId });

        const run = await this.db.run.findFirst({
            where: { id: runId, organizationId },
            select: { id: true },
        });
        if (run == null) throw new NotFoundError("Run not found");

        await this.db.run.delete({ where: { id: runId } });

        this.logger.info("Run deleted", { runId });
    }

    private async findAssignmentWithSteps(testCaseId: string, organizationId: string) {
        // Prefer assignment that already has stepsId set
        const assignmentWithSteps = await this.db.testCaseAssignment.findFirst({
            where: {
                testCaseId,
                testCase: { organizationId },
                stepsId: { not: null },
            },
            orderBy: { createdAt: "desc" },
            select: { id: true, stepsId: true, plan: { select: { scenarioId: true } } },
        });

        if (assignmentWithSteps != null) return assignmentWithSteps;

        // Fall back: find any assignment and check if there's a generation with steps
        const latestGeneration = await this.db.testGeneration.findFirst({
            where: {
                organizationId,
                status: "success",
                stepsId: { not: null },
                testPlan: { testCaseId },
            },
            orderBy: { createdAt: "desc" },
            select: { stepsId: true, testPlan: { select: { testCaseId: true, scenarioId: true } } },
        });

        if (latestGeneration?.stepsId == null) return null;

        const assignment = await this.db.testCaseAssignment.findFirst({
            where: { testCaseId, testCase: { organizationId } },
            orderBy: { createdAt: "desc" },
            select: { id: true, stepsId: true, plan: { select: { scenarioId: true } } },
        });

        if (assignment == null) return null;

        // Update the assignment with the latest generation's steps
        await this.db.testCaseAssignment.update({
            where: { id: assignment.id },
            data: { stepsId: latestGeneration.stepsId },
        });

        return {
            id: assignment.id,
            stepsId: latestGeneration.stepsId,
            plan: assignment.plan ?? { scenarioId: latestGeneration.testPlan.scenarioId },
        };
    }
}
