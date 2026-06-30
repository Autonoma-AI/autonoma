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
                // Shadow generations live on the detached investigation twin (a snapshot with a
                // non-null investigationParent). They are an internal A/B measurement, not part of
                // the customer's suite, so they 404 even by direct id - same hiding rule the
                // branch/snapshot read surface applies.
                snapshot: { investigationParent: { is: null } },
            },
            select: {
                id: true,
                status: true,
                reasoning: true,
                failure: true,
                finalScreenshot: true,
                videoUrl: true,
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
                generationReview: {
                    select: {
                        id: true,
                        status: true,
                        verdict: true,
                        issue: {
                            select: {
                                id: true,
                                severity: true,
                                title: true,
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

        const [steps, videoUrl, finalScreenshotUrl, temporalWorkflow, webhookCalls] = await Promise.all([
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
            review:
                generation.generationReview != null
                    ? {
                          status: generation.generationReview.status,
                          verdict: generation.generationReview.verdict ?? undefined,
                          issue:
                              generation.generationReview.issue != null
                                  ? {
                                        id: generation.generationReview.issue.id,
                                        severity: generation.generationReview.issue.severity,
                                        title: generation.generationReview.issue.title,
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
            steps,
            debug,
        };
    }

    async deleteGeneration(generationId: string, organizationId: string) {
        this.logger.info("Deleting generation", { generationId, organizationId });

        const generation = await this.db.testGeneration.findFirst({
            where: { id: generationId, organizationId },
            select: { outputsId: true, testPlan: { select: { testCaseId: true } } },
        });
        if (generation == null) return;

        await this.db.$transaction(async (tx) => {
            // The generation only points at its StepOutputList via the
            // non-cascading outputsId, so the TestCase cascade below won't remove
            // it - delete it explicitly to avoid orphaning it. (Its StepOutputs
            // are cleaned up either way, since StepOutput.stepInputId cascades.)
            if (generation.outputsId != null) {
                await tx.stepOutputList.delete({ where: { id: generation.outputsId } });
            }

            // Delete the TestCase - cascades to TestPlan → TestGeneration and StepInputList → StepInput
            await tx.testCase.delete({
                where: { id: generation.testPlan.testCaseId },
            });
        });

        this.logger.info("Generation deleted", { generationId });
    }

    async listGenerations(organizationId: string, applicationId?: string) {
        this.logger.info("Listing generations", { organizationId, applicationId });

        const generations = await this.db.testGeneration.findMany({
            where: {
                organizationId,
                // Exclude shadow generations on the detached investigation twin - they are an
                // internal A/B measurement, not part of the customer's suite history.
                snapshot: { investigationParent: { is: null } },
                ...(applicationId != null ? { testPlan: { testCase: { applicationId } } } : {}),
            },
            select: {
                id: true,
                status: true,
                createdAt: true,
                outputs: {
                    include: { _count: { select: { list: true } } },
                },
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
        });

        this.logger.info("Generations listed", { count: generations.length });

        return generations.map((gen) => {
            const testCase = gen.testPlan.testCase;
            return {
                id: gen.id,
                shortId: gen.id.slice(0, 8),
                testName: testCase.name,
                tags: testCase.tags.map((tt) => tt.tag.name),
                stepCount: gen.outputs?._count.list ?? 0,
                status: gen.status,
                createdAt: gen.createdAt,
            };
        });
    }
}
