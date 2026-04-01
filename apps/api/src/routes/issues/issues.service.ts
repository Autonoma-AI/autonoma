import type { PrismaClient } from "@autonoma/db";
import { GenerationStatus, RunStatus } from "@autonoma/db";
import { BadRequestError, ConflictError, NotFoundError } from "@autonoma/errors";
import type { StorageProvider } from "@autonoma/storage";
import type { TriggerGenerationReview, TriggerRunReview } from "../build-services";
import { Service } from "../service";
import { signEvidenceUrls } from "../sign-evidence-urls";

type EvidenceItem = { type: string; description: string; s3Key?: string };

export class IssuesService extends Service {
    constructor(
        private readonly db: PrismaClient,
        private readonly storageProvider: StorageProvider,
        private readonly triggerGenerationReview: TriggerGenerationReview,
        private readonly triggerRunReview: TriggerRunReview,
    ) {
        super();
    }

    async listIssues(organizationId: string, applicationId?: string) {
        this.logger.info("Listing issues", { organizationId, applicationId });

        const issues = await this.db.issue.findMany({
            where: {
                organizationId,
                ...(applicationId != null
                    ? {
                          OR: [
                              { generationReview: { generation: { testPlan: { testCase: { applicationId } } } } },
                              { runReview: { run: { assignment: { testCase: { applicationId } } } } },
                          ],
                      }
                    : {}),
            },
            select: {
                id: true,
                category: true,
                confidence: true,
                severity: true,
                title: true,
                createdAt: true,
                generationReview: {
                    select: {
                        generation: {
                            select: {
                                id: true,
                                status: true,
                                testPlan: {
                                    select: {
                                        testCase: {
                                            select: {
                                                name: true,
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
                runReview: {
                    select: {
                        run: {
                            select: {
                                id: true,
                                status: true,
                                assignment: {
                                    select: {
                                        testCase: {
                                            select: {
                                                name: true,
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
            orderBy: { createdAt: "desc" },
        });

        this.logger.info("Issues listed", { count: issues.length });

        return issues.map((issue) => {
            if (issue.generationReview != null) {
                return {
                    id: issue.id,
                    category: issue.category,
                    confidence: issue.confidence,
                    severity: issue.severity,
                    title: issue.title,
                    createdAt: issue.createdAt,
                    testName: issue.generationReview.generation.testPlan.testCase.name,
                    source: "generation" as const,
                    sourceId: issue.generationReview.generation.id,
                    sourceStatus: issue.generationReview.generation.status,
                };
            }

            const run = issue.runReview?.run;
            if (run == null) throw new NotFoundError();
            return {
                id: issue.id,
                category: issue.category,
                confidence: issue.confidence,
                severity: issue.severity,
                title: issue.title,
                createdAt: issue.createdAt,
                testName: run.assignment.testCase.name,
                source: "run" as const,
                sourceId: run.id,
                sourceStatus: run.status,
            };
        });
    }

    async getIssueDetail(issueId: string, organizationId: string) {
        this.logger.info("Getting issue detail", { issueId, organizationId });

        const issue = await this.db.issue.findFirst({
            where: { id: issueId, organizationId },
            select: {
                id: true,
                category: true,
                confidence: true,
                severity: true,
                title: true,
                description: true,
                createdAt: true,
                generationReview: {
                    select: {
                        id: true,
                        verdict: true,
                        reasoning: true,
                        analysis: true,
                        createdAt: true,
                        generation: {
                            select: {
                                id: true,
                                status: true,
                                testPlan: {
                                    select: {
                                        prompt: true,
                                        testCase: {
                                            select: {
                                                id: true,
                                                name: true,
                                                slug: true,
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
                runReview: {
                    select: {
                        id: true,
                        verdict: true,
                        reasoning: true,
                        analysis: true,
                        createdAt: true,
                        run: {
                            select: {
                                id: true,
                                status: true,
                                assignment: {
                                    select: {
                                        plan: { select: { prompt: true } },
                                        testCase: {
                                            select: {
                                                id: true,
                                                name: true,
                                                slug: true,
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        });

        if (issue == null) throw new NotFoundError();

        type AnalysisJson =
            | {
                  failurePoint?: { stepOrder?: number; description?: string };
                  evidence?: EvidenceItem[];
              }
            | undefined;

        if (issue.generationReview != null) {
            const analysis = issue.generationReview.analysis as AnalysisJson;
            const evidence = await signEvidenceUrls(analysis?.evidence ?? [], this.storageProvider);

            return {
                id: issue.id,
                category: issue.category,
                confidence: issue.confidence,
                severity: issue.severity,
                title: issue.title,
                description: issue.description,
                createdAt: issue.createdAt,
                review: {
                    id: issue.generationReview.id,
                    verdict: issue.generationReview.verdict,
                    reasoning: issue.generationReview.reasoning,
                    createdAt: issue.generationReview.createdAt,
                    failurePoint: analysis?.failurePoint,
                    evidence,
                },
                source: "generation" as const,
                generation: {
                    id: issue.generationReview.generation.id,
                    status: issue.generationReview.generation.status,
                },
                testCase: {
                    id: issue.generationReview.generation.testPlan.testCase.id,
                    name: issue.generationReview.generation.testPlan.testCase.name,
                    slug: issue.generationReview.generation.testPlan.testCase.slug,
                },
                testPlan: issue.generationReview.generation.testPlan.prompt,
            };
        }

        const runReview = issue.runReview;
        if (runReview == null) throw new NotFoundError();
        const analysis = runReview.analysis as AnalysisJson;
        const evidence = await signEvidenceUrls(analysis?.evidence ?? [], this.storageProvider);

        return {
            id: issue.id,
            category: issue.category,
            confidence: issue.confidence,
            severity: issue.severity,
            title: issue.title,
            description: issue.description,
            createdAt: issue.createdAt,
            review: {
                id: runReview.id,
                verdict: runReview.verdict,
                reasoning: runReview.reasoning,
                createdAt: runReview.createdAt,
                failurePoint: analysis?.failurePoint,
                evidence,
            },
            source: "run" as const,
            run: {
                id: runReview.run.id,
                status: runReview.run.status,
            },
            testCase: {
                id: runReview.run.assignment.testCase.id,
                name: runReview.run.assignment.testCase.name,
                slug: runReview.run.assignment.testCase.slug,
            },
            testPlan: runReview.run.assignment.plan?.prompt ?? undefined,
        };
    }

    async requestReview(generationId: string, organizationId: string) {
        this.logger.info("Requesting generation review", { generationId, organizationId });

        const generation = await this.db.testGeneration.findFirst({
            where: { id: generationId, organizationId },
            select: { id: true, status: true, generationReview: { select: { id: true, status: true } } },
        });

        if (generation == null) throw new NotFoundError();

        if (generation.status !== GenerationStatus.failed) {
            throw new BadRequestError("Only failed generations can be reviewed");
        }

        const existingReview = generation.generationReview;
        if (existingReview != null && existingReview.status !== "failed") {
            throw new ConflictError("A review already exists for this generation");
        }

        if (existingReview != null) {
            await this.db.generationReview.delete({ where: { id: existingReview.id } });
        }

        await this.db.generationReview.create({
            data: {
                generationId,
                organizationId,
            },
        });

        await this.triggerGenerationReview(generationId);

        this.logger.info("Generation review triggered", { generationId });
    }

    async requestRunReview(runId: string, organizationId: string) {
        this.logger.info("Requesting run review", { runId, organizationId });

        const run = await this.db.run.findFirst({
            where: { id: runId, organizationId },
            select: { id: true, status: true, runReview: { select: { id: true, status: true } } },
        });

        if (run == null) throw new NotFoundError();

        if (run.status !== RunStatus.failed) {
            throw new BadRequestError("Only failed runs can be reviewed");
        }

        const existingReview = run.runReview;
        if (existingReview != null && existingReview.status !== "failed") {
            throw new ConflictError("A review already exists for this run");
        }

        if (existingReview != null) {
            await this.db.runReview.delete({ where: { id: existingReview.id } });
        }

        await this.db.runReview.create({
            data: {
                runId,
                organizationId,
            },
        });

        await this.triggerRunReview(runId);

        this.logger.info("Run review triggered", { runId });
    }
}
