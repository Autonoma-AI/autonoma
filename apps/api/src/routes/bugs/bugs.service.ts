import type { PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import { BUG_CONFIDENCE_THRESHOLD, type BugLinker } from "@autonoma/review";
import type { StorageProvider } from "@autonoma/storage";
import { Service } from "../service";
import { signEvidenceUrls } from "../sign-evidence-urls";

type EvidenceItem = { type: string; description: string; s3Key?: string };

export class BugsService extends Service {
    constructor(
        private readonly db: PrismaClient,
        private readonly storageProvider: StorageProvider,
        private readonly bugLinker: BugLinker,
    ) {
        super();
    }

    async listBugs(organizationId: string, applicationId?: string, status?: "open" | "resolved" | "regressed") {
        this.logger.info("Listing bugs", { organizationId, applicationId, status });

        const bugs = await this.db.bug.findMany({
            where: {
                organizationId,
                ...(applicationId != null ? { branch: { applicationId } } : {}),
                ...(status != null ? { status } : {}),
            },
            select: {
                id: true,
                status: true,
                title: true,
                severity: true,
                firstSeenAt: true,
                lastSeenAt: true,
                resolvedAt: true,
                testCase: { select: { id: true, name: true, slug: true } },
                branch: { select: { id: true, name: true } },
                _count: { select: { issues: true } },
            },
            orderBy: { lastSeenAt: "desc" },
        });

        this.logger.info("Bugs listed", { count: bugs.length });

        return bugs.map((bug) => ({
            id: bug.id,
            status: bug.status,
            title: bug.title,
            severity: bug.severity,
            firstSeenAt: bug.firstSeenAt,
            lastSeenAt: bug.lastSeenAt,
            resolvedAt: bug.resolvedAt,
            testCase: bug.testCase,
            branch: bug.branch,
            occurrences: bug._count.issues,
        }));
    }

    async getBugDetail(bugId: string, organizationId: string) {
        this.logger.info("Getting bug detail", { bugId, organizationId });

        const bug = await this.db.bug.findFirst({
            where: { id: bugId, organizationId },
            select: {
                id: true,
                status: true,
                title: true,
                description: true,
                severity: true,
                firstSeenAt: true,
                lastSeenAt: true,
                resolvedAt: true,
                testCase: { select: { id: true, name: true, slug: true } },
                branch: { select: { id: true, name: true } },
                issues: {
                    select: {
                        id: true,
                        title: true,
                        confidence: true,
                        severity: true,
                        createdAt: true,
                        generationReview: {
                            select: {
                                analysis: true,
                                generation: { select: { id: true, status: true } },
                            },
                        },
                        runReview: {
                            select: {
                                analysis: true,
                                run: { select: { id: true, status: true } },
                            },
                        },
                    },
                    orderBy: { createdAt: "desc" },
                },
            },
        });

        if (bug == null) throw new NotFoundError();

        type AnalysisJson = { evidence?: EvidenceItem[] } | undefined;

        const issues = await Promise.all(
            bug.issues.map(async (issue) => {
                const analysis = (issue.generationReview?.analysis ?? issue.runReview?.analysis) as AnalysisJson;
                const evidence = await signEvidenceUrls(analysis?.evidence ?? [], this.storageProvider);

                return {
                    id: issue.id,
                    title: issue.title,
                    confidence: issue.confidence,
                    severity: issue.severity,
                    createdAt: issue.createdAt,
                    source: issue.generationReview != null ? ("generation" as const) : ("run" as const),
                    sourceId: issue.generationReview?.generation.id ?? issue.runReview?.run.id,
                    sourceStatus: issue.generationReview?.generation.status ?? issue.runReview?.run.status,
                    evidence,
                };
            }),
        );

        return {
            id: bug.id,
            status: bug.status,
            title: bug.title,
            description: bug.description,
            severity: bug.severity,
            firstSeenAt: bug.firstSeenAt,
            lastSeenAt: bug.lastSeenAt,
            resolvedAt: bug.resolvedAt,
            testCase: bug.testCase,
            branch: bug.branch,
            issues,
        };
    }

    async pendingReview(organizationId: string, applicationId?: string) {
        this.logger.info("Listing issues pending bug review", { organizationId, applicationId });

        const issues = await this.db.issue.findMany({
            where: {
                organizationId,
                category: "application_bug",
                confidence: { lt: BUG_CONFIDENCE_THRESHOLD },
                bugId: null,
                dismissed: false,
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
                title: true,
                confidence: true,
                severity: true,
                description: true,
                createdAt: true,
                generationReview: {
                    select: {
                        generation: {
                            select: {
                                id: true,
                                testPlan: { select: { testCase: { select: { name: true } } } },
                            },
                        },
                    },
                },
                runReview: {
                    select: {
                        run: {
                            select: {
                                id: true,
                                assignment: { select: { testCase: { select: { name: true } } } },
                            },
                        },
                    },
                },
            },
            orderBy: { createdAt: "desc" },
        });

        return issues.map((issue) => ({
            id: issue.id,
            title: issue.title,
            confidence: issue.confidence,
            severity: issue.severity,
            description: issue.description,
            createdAt: issue.createdAt,
            testName:
                issue.generationReview?.generation.testPlan.testCase.name ??
                issue.runReview?.run.assignment.testCase.name,
            source: issue.generationReview != null ? ("generation" as const) : ("run" as const),
            sourceId: issue.generationReview?.generation.id ?? issue.runReview?.run.id,
        }));
    }

    async confirmIssue(issueId: string, organizationId: string) {
        this.logger.info("Confirming issue as bug", { issueId, organizationId });

        const issue = await this.db.issue.findFirst({
            where: { id: issueId, organizationId, category: "application_bug", bugId: null },
            select: {
                id: true,
                title: true,
                description: true,
                severity: true,
                generationReview: {
                    select: {
                        generation: {
                            select: {
                                snapshot: { select: { branchId: true } },
                                testPlan: { select: { testCaseId: true } },
                            },
                        },
                    },
                },
                runReview: {
                    select: {
                        run: {
                            select: {
                                assignment: {
                                    select: {
                                        testCaseId: true,
                                        snapshot: { select: { branchId: true } },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        });

        if (issue == null) throw new NotFoundError();

        let branchId: string;
        let testCaseId: string;

        if (issue.generationReview != null) {
            branchId = issue.generationReview.generation.snapshot.branchId;
            testCaseId = issue.generationReview.generation.testPlan.testCaseId;
        } else if (issue.runReview != null) {
            branchId = issue.runReview.run.assignment.snapshot.branchId;
            testCaseId = issue.runReview.run.assignment.testCaseId;
        } else {
            throw new NotFoundError("Issue has no associated review");
        }

        await this.db.$transaction(async (tx) => {
            await this.bugLinker.linkIssueToBug(tx, {
                issueId: issue.id,
                issueTitle: issue.title,
                issueDescription: issue.description,
                branchId,
                testCaseId,
                severity: issue.severity,
                organizationId,
            });
        });

        this.logger.info("Issue confirmed as bug", { issueId });
    }

    async dismissIssue(issueId: string, organizationId: string) {
        this.logger.info("Dismissing issue", { issueId, organizationId });

        const issue = await this.db.issue.findFirst({
            where: { id: issueId, organizationId },
            select: { id: true },
        });

        if (issue == null) throw new NotFoundError();

        await this.db.issue.update({
            where: { id: issueId },
            data: { dismissed: true },
        });

        this.logger.info("Issue dismissed", { issueId });
    }
}
