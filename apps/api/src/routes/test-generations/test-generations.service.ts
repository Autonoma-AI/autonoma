import type { BillingService } from "@autonoma/billing";
import type { PrismaClient } from "@autonoma/db";
import { GenerationStatus } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import type { StorageProvider } from "@autonoma/storage";
import type { GenerationProvider } from "@autonoma/test-updates";
import { type WorkflowArchitecture, findLatestWorkflowByGenerationId } from "@autonoma/workflow";
import { env } from "../../env";
import { Service } from "../service";

export class TestGenerationsService extends Service {
    constructor(
        private readonly db: PrismaClient,
        private readonly storageProvider: StorageProvider,
        private readonly generationProvider: GenerationProvider,
        private readonly billingService: BillingService,
    ) {
        super();
    }

    async getGenerationDetail(generationId: string, organizationId: string) {
        this.logger.info("Getting generation detail", { generationId, organizationId });

        console.time(`generation-detail:query:${generationId}`);
        const generation = await this.db.testGeneration.findFirst({
            where: {
                id: generationId,
                organizationId,
            },
            select: {
                id: true,
                status: true,
                reasoning: true,
                finalScreenshot: true,
                videoUrl: true,
                createdAt: true,
                testPlan: {
                    select: {
                        id: true,
                        prompt: true,
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
                outputs: {
                    include: {
                        list: {
                            orderBy: { order: "asc" },
                            include: {
                                stepInput: {
                                    select: {
                                        interaction: true,
                                        params: true,
                                    },
                                },
                            },
                        },
                    },
                },
            },
        });

        console.timeEnd(`generation-detail:query:${generationId}`);

        if (generation == null) throw new NotFoundError();

        const outputSteps = generation.outputs?.list ?? [];

        this.logger.info("Generation detail retrieved", {
            generationId,
            status: generation.status,
            stepCount: outputSteps.length,
        });

        console.time(`generation-detail:post-query:${generationId}`);
        const [steps, videoUrl, finalScreenshotUrl, argoWorkflow] = await Promise.all([
            Promise.all(
                outputSteps.map(async ({ screenshotBefore, screenshotAfter, ...rest }) => ({
                    id: rest.id,
                    order: rest.order,
                    interaction: rest.stepInput.interaction,
                    params: rest.stepInput.params,
                    output: rest.output,
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
            env.NODE_ENV === "production"
                ? findLatestWorkflowByGenerationId(generation.id)
                      .then((workflow) => (workflow != null ? { name: workflow.name, uid: workflow.uid } : undefined))
                      .catch((error) => {
                          this.logger.warn("Could not resolve Argo workflow for generation", {
                              generationId: generation.id,
                              error,
                          });
                          return undefined;
                      })
                : Promise.resolve(undefined),
        ]);

        console.timeEnd(`generation-detail:post-query:${generationId}`);

        return {
            id: generation.id,
            shortId: generation.id.slice(0, 8),
            architecture: generation.testPlan.testCase.application.architecture,
            createdAt: generation.createdAt,
            status: generation.status,
            reasoning: generation.reasoning ?? undefined,
            finalScreenshot: finalScreenshotUrl,
            videoUrl,
            argoWorkflow,
            testPlan: {
                id: generation.testPlan.id,
                plan: generation.testPlan.prompt,
                name: generation.testPlan.testCase.name,
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
            steps,
        };
    }

    async rerunGeneration(generationId: string, organizationId: string, planContent?: string) {
        this.logger.info("Rerunning generation", { generationId, organizationId });

        const existing = await this.db.testGeneration.findFirst({
            where: { id: generationId, organizationId },
            select: {
                testPlanId: true,
                stepsId: true,
                outputsId: true,
                conversationUrl: true,
                testPlan: {
                    select: {
                        prompt: true,
                        scenarioId: true,
                        testCase: {
                            select: { application: { select: { architecture: true } } },
                        },
                    },
                },
            },
        });
        if (existing == null) throw new NotFoundError();

        // Update the plan content if provided
        if (planContent != null) {
            await this.db.testPlan.update({
                where: { id: existing.testPlanId },
                data: { prompt: planContent },
            });
        }

        // Delete old conversation from S3 if present
        if (existing.conversationUrl != null) {
            await this.storageProvider.delete(existing.conversationUrl).catch((error) => {
                this.logger.warn("Failed to delete old conversation from S3", { error });
            });
        }

        // Reset the generation to a clean pending state
        await this.db.testGeneration.update({
            where: { id: generationId },
            data: {
                status: GenerationStatus.pending,
                reasoning: null,
                finalScreenshot: null,
                videoUrl: null,
                conversationUrl: null,
                memory: {},
                stepsId: null,
                outputsId: null,
            },
        });

        // Delete old step data
        if (existing.outputsId != null) await this.db.stepOutputList.delete({ where: { id: existing.outputsId } });

        if (existing.stepsId != null) await this.db.stepInputList.delete({ where: { id: existing.stepsId } });

        const scenarioId = existing.testPlan.scenarioId ?? undefined;
        const architecture = existing.testPlan.testCase.application.architecture as WorkflowArchitecture;

        await this.generationProvider.fireJobs([
            { testGenerationId: generationId, planId: existing.testPlanId, scenarioId, architecture },
        ]);

        this.logger.info("Generation rerun triggered", { generationId });
    }

    async deleteGeneration(generationId: string, organizationId: string) {
        this.logger.info("Deleting generation", { generationId, organizationId });

        const generation = await this.db.testGeneration.findFirst({
            where: { id: generationId, organizationId },
            select: { outputsId: true, testPlan: { select: { testCaseId: true } } },
        });
        if (generation == null) return;

        await this.db.$transaction(async (tx) => {
            // Delete StepOutputList first - StepOutput.stepInputId has no cascade,
            // so it must be gone before StepInputs are deleted via the TestCase cascade
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
