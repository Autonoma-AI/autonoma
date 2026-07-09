import type { PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import type { StorageProvider } from "@autonoma/storage";
import { type WorkflowRef, findLatestWorkflowByRunId } from "@autonoma/workflow";
import { buildScenarioDebug } from "../scenario-debug";
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

export class RunsService extends Service {
    constructor(
        private readonly db: PrismaClient,
        private readonly storageProvider: StorageProvider,
    ) {
        super();
    }

    async getRunDetail(runId: string, organizationId: string, isAdmin: boolean) {
        this.logger.info("Getting run detail", { runId, organizationId, isAdmin });

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
                        snapshot: {
                            select: {
                                id: true,
                                status: true,
                                headSha: true,
                                branch: {
                                    select: {
                                        id: true,
                                        name: true,
                                        prInfo: { select: { prNumber: true } },
                                    },
                                },
                            },
                        },
                    },
                },
                outputs: {
                    include: {
                        list: {
                            include: {
                                stepInput: {
                                    select: { interaction: true, params: true, waitCondition: true },
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
                scenarioInstance: {
                    select: {
                        id: true,
                        status: true,
                        upAt: true,
                        downAt: true,
                        lastError: true,
                        auth: true,
                        resolvedVariables: true,
                        scenario: { select: { id: true, name: true } },
                        deployment: {
                            select: {
                                webhookUrl: true,
                                webDeployment: { select: { url: true } },
                            },
                        },
                    },
                },
                plan: {
                    select: {
                        scenarioName: true,
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

        const webhookCallsPromise =
            isAdmin && run.scenarioInstance != null
                ? this.db.webhookCall.findMany({
                      where: { instanceId: run.scenarioInstance.id },
                      orderBy: { createdAt: "desc" },
                  })
                : Promise.resolve([]);

        const [steps, temporalWorkflow, webhookCalls] = await Promise.all([
            Promise.all(
                outputSteps.map(async (step) => ({
                    id: step.id,
                    order: step.order,
                    output: step.output,
                    interaction: step.stepInput.interaction,
                    params: step.stepInput.params,
                    waitCondition: step.stepInput.waitCondition,
                    screenshotBefore: await (step.screenshotBefore &&
                        this.storageProvider.getSignedUrl(step.screenshotBefore, 3600)),
                    screenshotAfter: await (step.screenshotAfter &&
                        this.storageProvider.getSignedUrl(step.screenshotAfter, 3600)),
                })),
            ),
            temporalWorkflowPromise,
            webhookCallsPromise,
        ]);

        const debug = isAdmin
            ? buildScenarioDebug({
                  scenarioInstance: run.scenarioInstance,
                  snapshot: run.assignment.snapshot,
                  webhookCalls,
                  scenarioName: run.plan?.scenarioName,
              })
            : undefined;

        const snapshot = run.assignment.snapshot;
        const prNumber = snapshot.branch.prInfo?.prNumber;

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
            failure: run.failure ?? undefined,
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
            pullRequest:
                prNumber != null
                    ? {
                          number: prNumber,
                          snapshotId: snapshot.id,
                          snapshotSha: snapshot.headSha ?? undefined,
                      }
                    : undefined,
            debug,
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
                    testCaseId: run.assignment.testCase.id,
                    tags: run.assignment.testCase.tags.map((tt) => tt.tag.name),
                    startedAt: run.startedAt ?? null,
                    duration: computeDuration(run.startedAt, run.completedAt),
                    stepCount: run.outputs?._count.list ?? 0,
                    lastScreenshot,
                };
            }),
        );
    }

    /**
     * The recent run history for a single test case, newest first, across every snapshot it has been
     * assigned to. Powers the "Latest runs" panel on the test detail page: each row carries the pass/fail
     * status, duration, and the pull request / commit / branch that triggered it. Commit author is not
     * stored per run, so we surface the PR author login (from the branch's cached PR metadata) instead.
     */
    async listRunsForTestCase(testCaseId: string, organizationId: string, limit: number) {
        this.logger.info("Listing runs for test case", { testCaseId, organizationId, limit });

        const runs = await this.db.run.findMany({
            where: {
                assignment: {
                    testCaseId,
                    testCase: { application: { organizationId } },
                },
            },
            include: {
                assignment: {
                    include: {
                        snapshot: {
                            select: {
                                id: true,
                                headSha: true,
                                branch: {
                                    select: {
                                        name: true,
                                        prInfo: {
                                            select: { prNumber: true, prTitle: true, prAuthorLogin: true },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
            orderBy: { createdAt: "desc" },
            take: limit,
        });

        this.logger.info("Runs for test case listed", { testCaseId, count: runs.length });

        return runs.map((run) => {
            const snapshot = run.assignment.snapshot;
            const prInfo = snapshot.branch.prInfo;
            return {
                id: run.id,
                status: run.status,
                duration: computeDuration(run.startedAt, run.completedAt),
                createdAt: run.createdAt.toISOString(),
                branchName: snapshot.branch.name,
                sha: snapshot.headSha != null ? snapshot.headSha.slice(0, 7) : undefined,
                prNumber: prInfo?.prNumber ?? undefined,
                prTitle: prInfo?.prTitle ?? undefined,
                author: prInfo?.prAuthorLogin ?? undefined,
            };
        });
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
}
