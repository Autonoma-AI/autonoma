import type { BillingService } from "@autonoma/billing";
import type { PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import type { StorageProvider } from "@autonoma/storage";
import { findLatestWorkflowByGenerationId } from "@autonoma/workflow";
import { buildScenarioDebug } from "../scenario-debug";
import { Service } from "../service";

export class TestGenerationsService extends Service {
    constructor(
        private readonly db: PrismaClient,
        private readonly storageProvider: StorageProvider,
        private readonly billingService: BillingService,
    ) {
        super();
    }

    async getGenerationDetail(generationId: string, organizationId: string, isAdmin: boolean) {
        this.logger.info("Getting generation detail", { generationId, organizationId, isAdmin });

        const generation = await this.db.testGeneration.findFirst({
            where: {
                id: generationId,
                organizationId,
            },
            select: {
                id: true,
                status: true,
                reasoning: true,
                failure: true,
                finalScreenshot: true,
                videoUrl: true,
                optimizedVideoUrl: true,
                createdAt: true,
                conversationUrl: true,
                testPlan: {
                    select: {
                        id: true,
                        prompt: true,
                        scenarioName: true,
                        testCase: {
                            select: {
                                id: true,
                                name: true,
                                slug: true,
                                application: { select: { architecture: true } },
                            },
                        },
                    },
                },
                attempts: {
                    orderBy: { order: "asc" },
                    select: {
                        id: true,
                        order: true,
                        interaction: true,
                        params: true,
                        status: true,
                        output: true,
                        error: true,
                        errorName: true,
                        screenshotBefore: true,
                        screenshotAfter: true,
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
        });

        if (generation == null) throw new NotFoundError();

        const attempts = generation.attempts;

        this.logger.info("Generation detail retrieved", {
            generationId,
            status: generation.status,
            stepCount: attempts.length,
        });

        const webhookCallsPromise =
            isAdmin && generation.scenarioInstance != null
                ? this.db.webhookCall.findMany({
                      where: { instanceId: generation.scenarioInstance.id },
                      orderBy: { createdAt: "desc" },
                  })
                : Promise.resolve([]);

        const [steps, videoUrl, optimizedVideoUrl, finalScreenshotUrl, temporalWorkflow, webhookCalls] =
            await Promise.all([
                Promise.all(
                    attempts.map(async ({ screenshotBefore, screenshotAfter, ...rest }) => ({
                        id: rest.id,
                        order: rest.order,
                        interaction: rest.interaction,
                        params: rest.params,
                        status: rest.status,
                        output: rest.output ?? undefined,
                        error: rest.error ?? undefined,
                        errorName: rest.errorName ?? undefined,
                        screenshotBefore: await (screenshotBefore &&
                            this.storageProvider.getSignedUrl(screenshotBefore, 3600)),
                        screenshotAfter: await (screenshotAfter &&
                            this.storageProvider.getSignedUrl(screenshotAfter, 3600)),
                    })),
                ),
                generation.videoUrl != null
                    ? this.storageProvider.getSignedUrl(generation.videoUrl, 3600)
                    : Promise.resolve(undefined),
                generation.optimizedVideoUrl != null
                    ? this.storageProvider.getSignedUrl(generation.optimizedVideoUrl, 3600)
                    : Promise.resolve(undefined),
                generation.finalScreenshot != null
                    ? this.storageProvider.getSignedUrl(generation.finalScreenshot, 3600)
                    : Promise.resolve(undefined),
                findLatestWorkflowByGenerationId(generation.id)
                    .then((workflow) =>
                        workflow != null ? { workflowId: workflow.workflowId, runId: workflow.runId } : undefined,
                    )
                    .catch((error) => {
                        this.logger.warn("Could not resolve Temporal workflow for generation", {
                            generationId: generation.id,
                            error,
                        });
                        return undefined;
                    }),
                webhookCallsPromise,
            ]);

        const conversationUrl =
            isAdmin && generation.conversationUrl != null
                ? await this.storageProvider.getSignedUrl(generation.conversationUrl, 3600)
                : undefined;

        const debug = isAdmin
            ? buildScenarioDebug({
                  scenarioInstance: generation.scenarioInstance,
                  snapshot: generation.snapshot,
                  webhookCalls,
                  scenarioName: generation.testPlan.scenarioName,
              })
            : undefined;

        const snapshot = generation.snapshot;
        const prNumber = snapshot.branch.prInfo?.prNumber;

        return {
            id: generation.id,
            shortId: generation.id.slice(0, 8),
            architecture: generation.testPlan.testCase.application.architecture,
            createdAt: generation.createdAt,
            status: generation.status,
            reasoning: generation.reasoning ?? undefined,
            failure: generation.failure ?? undefined,
            finalScreenshot: finalScreenshotUrl,
            videoUrl,
            optimizedVideoUrl,
            temporalWorkflow,
            conversationUrl,
            testPlan: {
                id: generation.testPlan.id,
                plan: generation.testPlan.prompt,
                name: generation.testPlan.testCase.name,
                scenarioName: generation.testPlan.scenarioName ?? undefined,
            },
            testCase: {
                id: generation.testPlan.testCase.id,
                name: generation.testPlan.testCase.name,
                slug: generation.testPlan.testCase.slug,
            },
            pullRequest:
                prNumber != null
                    ? {
                          number: prNumber,
                          snapshotId: snapshot.id,
                          snapshotSha: snapshot.headSha ?? undefined,
                      }
                    : undefined,
            steps,
            debug,
        };
    }

    async listGenerations(organizationId: string, applicationId?: string) {
        this.logger.info("Listing generations", { organizationId, applicationId });

        const generations = await this.db.testGeneration.findMany({
            where: {
                organizationId,
                ...(applicationId != null ? { testPlan: { testCase: { applicationId } } } : {}),
            },
            select: {
                id: true,
                status: true,
                createdAt: true,
                _count: { select: { attempts: true } },
                testPlan: {
                    select: {
                        testCase: {
                            select: {
                                id: true,
                                name: true,
                                tags: { include: { tag: true } },
                            },
                        },
                    },
                },
            },
            orderBy: { createdAt: "desc" },
            // `test_generation` grows monotonically with runs, so bound this to the most recent window to avoid
            // loading an org/app's entire generation history into memory (OOM risk at scale). The UI renders a
            // recent-first list and only polls while a generation is active - active rows are always the newest,
            // so they stay within the window. Replace with real pagination if the list ever needs to page back.
            take: 500,
        });

        this.logger.info("Generations listed", { count: generations.length });

        return generations.map((gen) => {
            const testCase = gen.testPlan.testCase;
            return {
                id: gen.id,
                shortId: gen.id.slice(0, 8),
                testName: testCase.name,
                tags: testCase.tags.map((tt) => tt.tag.name),
                stepCount: gen._count.attempts,
                status: gen.status,
                createdAt: gen.createdAt,
            };
        });
    }
}
