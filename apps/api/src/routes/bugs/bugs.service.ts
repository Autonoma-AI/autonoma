import type { PostHogAnalytics } from "@autonoma/analytics";
import type { Prisma, PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import type { StorageProvider } from "@autonoma/storage";
import type { BugVerdict } from "@autonoma/types";
import { z } from "zod";
import { Service } from "../service";
import { signEvidenceUrls } from "../sign-evidence-urls";
import { buildBugDetailBlocks } from "./bug-detail-blocks";

type EvidenceItem = { type: string; description: string; s3Key?: string };
type BugStatus = "open" | "resolved" | "regressed";
type BugSeverity = "critical" | "high" | "medium" | "low";

const SEVERITY_RANK: Record<BugSeverity, number> = {
    critical: 4,
    high: 3,
    medium: 2,
    low: 1,
};

const evidenceItemSchema = z.object({
    type: z.string(),
    description: z.string(),
    s3Key: z.string().optional(),
});

const analysisSchema = z
    .object({
        evidence: z.array(evidenceItemSchema).optional(),
    })
    .passthrough();

type SignedEvidenceItem = { type: string; description: string; url?: string };

interface ListBugsByPrParams {
    organizationId: string;
    applicationId: string;
    branchId: string;
    status: BugStatus;
    snapshotId?: string;
}

export const bugDetailIssueSummarySelect = {
    id: true,
    title: true,
    severity: true,
    createdAt: true,
    generationReview: {
        select: {
            analysis: true,
            generation: {
                select: {
                    id: true,
                    status: true,
                    snapshot: {
                        select: {
                            id: true,
                            headSha: true,
                            createdAt: true,
                            branch: {
                                select: {
                                    name: true,
                                    prInfo: { select: { prNumber: true } },
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
            analysis: true,
            run: {
                select: {
                    id: true,
                    status: true,
                    assignment: {
                        select: {
                            testCase: { select: { slug: true } },
                            snapshot: {
                                select: {
                                    id: true,
                                    headSha: true,
                                    createdAt: true,
                                    branch: {
                                        select: {
                                            name: true,
                                            prInfo: { select: { prNumber: true } },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
    },
} satisfies Prisma.IssueSelect;

export const bugDetailLatestOccurrenceIssueSelect = {
    id: true,
    title: true,
    severity: true,
    createdAt: true,
    generationReview: {
        select: {
            analysis: true,
            reasoning: true,
            generation: {
                select: {
                    id: true,
                    status: true,
                    finalScreenshot: true,
                    videoUrl: true,
                    createdAt: true,
                    testPlan: {
                        select: {
                            testCase: { select: { id: true, slug: true } },
                        },
                    },
                    snapshot: {
                        select: {
                            id: true,
                            headSha: true,
                            createdAt: true,
                            branch: {
                                select: {
                                    name: true,
                                    prInfo: { select: { prNumber: true } },
                                },
                            },
                        },
                    },
                    outputs: {
                        select: {
                            list: {
                                orderBy: { order: "asc" },
                                select: {
                                    order: true,
                                    output: true,
                                    screenshotBefore: true,
                                    screenshotAfter: true,
                                    stepInput: {
                                        select: { interaction: true, params: true },
                                    },
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
            analysis: true,
            reasoning: true,
            run: {
                select: {
                    id: true,
                    status: true,
                    createdAt: true,
                    assignment: {
                        select: {
                            testCase: { select: { id: true, slug: true } },
                            snapshot: {
                                select: {
                                    id: true,
                                    headSha: true,
                                    createdAt: true,
                                    branch: {
                                        select: {
                                            name: true,
                                            prInfo: { select: { prNumber: true } },
                                        },
                                    },
                                },
                            },
                        },
                    },
                    outputs: {
                        select: {
                            list: {
                                orderBy: { order: "asc" },
                                select: {
                                    order: true,
                                    output: true,
                                    screenshotBefore: true,
                                    screenshotAfter: true,
                                    stepInput: {
                                        select: { interaction: true, params: true },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
    },
} satisfies Prisma.IssueSelect;

export type BugIssueRow = Prisma.IssueGetPayload<{ select: typeof bugDetailIssueSummarySelect }>;
export type BugLatestOccurrenceIssueRow = Prisma.IssueGetPayload<{
    select: typeof bugDetailLatestOccurrenceIssueSelect;
}>;

function isImageEvidence(item: SignedEvidenceItem): boolean {
    return item.url != null && (item.type === "screenshot" || item.type === "image");
}

export class BugsService extends Service {
    constructor(
        private readonly db: PrismaClient,
        private readonly storageProvider: StorageProvider,
        private readonly analytics: PostHogAnalytics,
        private readonly appUrl: string,
    ) {
        super();
    }

    async listBugs(organizationId: string, applicationId?: string, status?: BugStatus) {
        this.logger.info("Listing bugs", { organizationId, applicationId, status });

        const bugs = await this.db.bug.findMany({
            where: {
                organizationId,
                ...(applicationId != null ? { applicationId } : {}),
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
                application: { select: { id: true, name: true, slug: true } },
                evidence: {
                    select: {
                        testCase: { select: { id: true, name: true, slug: true } },
                    },
                    orderBy: { lastSeenAt: "desc" },
                },
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
            application: bug.application,
            testCases: bug.evidence.map((e) => e.testCase),
            occurrences: bug._count.issues,
        }));
    }

    async listBugsSummary(organizationId: string, applicationId?: string, status?: BugStatus) {
        this.logger.info("Listing bug summaries", { organizationId, applicationId, status });

        const bugs = await this.db.bug.findMany({
            where: {
                organizationId,
                ...(applicationId != null ? { applicationId } : {}),
                ...(status != null ? { status } : {}),
            },
            select: {
                id: true,
                status: true,
                title: true,
                severity: true,
                lastSeenAt: true,
                _count: { select: { issues: true } },
            },
            orderBy: { lastSeenAt: "desc" },
        });

        this.logger.info("Bug summaries listed", { count: bugs.length });

        return bugs.map((bug) => ({
            id: bug.id,
            status: bug.status,
            title: bug.title,
            severity: bug.severity,
            lastSeenAt: bug.lastSeenAt,
            occurrences: bug._count.issues,
        }));
    }

    async listBugsByPr(params: ListBugsByPrParams) {
        const { organizationId, applicationId, branchId, status, snapshotId } = params;
        this.logger.info("Listing bugs by PR", { organizationId, applicationId, branchId, status, snapshotId });

        const issueScope = this.buildPrIssueScope(params);

        const bugs = await this.db.bug.findMany({
            where: {
                organizationId,
                applicationId,
                status,
                issues: {
                    some: issueScope,
                },
            },
            select: {
                id: true,
                status: true,
                title: true,
                description: true,
                severity: true,
                firstSeenAt: true,
                lastSeenAt: true,
                resolvedAt: true,
                application: { select: { id: true, name: true, slug: true } },
                evidence: {
                    select: {
                        testCase: { select: { id: true, name: true, slug: true } },
                    },
                    orderBy: { lastSeenAt: "desc" },
                },
                issues: {
                    where: issueScope,
                    select: {
                        id: true,
                        createdAt: true,
                        generationReview: { select: { analysis: true } },
                        runReview: { select: { analysis: true } },
                    },
                    orderBy: { createdAt: "desc" },
                },
            },
        });

        const rows = await Promise.all(
            bugs.map(async (bug) => ({
                id: bug.id,
                status: bug.status,
                title: bug.title,
                description: bug.description,
                severity: bug.severity,
                firstSeenAt: bug.firstSeenAt,
                lastSeenAt: bug.lastSeenAt,
                resolvedAt: bug.resolvedAt,
                application: bug.application,
                testCases: bug.evidence.map((e) => e.testCase),
                occurrences: bug.issues.length,
                thumbnail: await this.findIssueThumbnail(bug.issues),
            })),
        );

        const sorted = rows
            .sort((a, b) => {
                const severityDelta = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
                if (severityDelta !== 0) return severityDelta;
                const lastSeenDelta = b.lastSeenAt.getTime() - a.lastSeenAt.getTime();
                if (lastSeenDelta !== 0) return lastSeenDelta;
                return b.occurrences - a.occurrences;
            })
            .slice(0, 50);

        this.logger.info("PR bugs listed", { count: sorted.length, snapshotId });

        return sorted;
    }

    private buildPrIssueScope({
        organizationId,
        applicationId,
        branchId,
        snapshotId,
    }: ListBugsByPrParams): Prisma.IssueWhereInput {
        const generationScope: Prisma.IssueWhereInput =
            snapshotId != null
                ? {
                      generationReview: {
                          is: {
                              generation: {
                                  snapshotId,
                                  snapshot: {
                                      branchId,
                                      branch: {
                                          applicationId,
                                          organizationId,
                                      },
                                  },
                              },
                          },
                      },
                  }
                : {
                      generationReview: {
                          is: {
                              generation: {
                                  snapshot: {
                                      branchId,
                                      branch: {
                                          applicationId,
                                          organizationId,
                                      },
                                  },
                              },
                          },
                      },
                  };

        if (snapshotId == null) return generationScope;

        return {
            OR: [
                generationScope,
                {
                    runReview: {
                        is: {
                            run: {
                                assignment: {
                                    snapshotId,
                                    snapshot: {
                                        branchId,
                                        branch: {
                                            applicationId,
                                            organizationId,
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            ],
        };
    }

    private async findIssueThumbnail(
        issues: Array<{
            generationReview: { analysis: unknown } | null;
            runReview: { analysis: unknown } | null;
        }>,
    ): Promise<SignedEvidenceItem | undefined> {
        for (const issue of issues) {
            const evidence = this.parseEvidence(issue.generationReview?.analysis ?? issue.runReview?.analysis);
            const signedEvidence = await signEvidenceUrls(evidence, this.storageProvider);
            const thumbnail = signedEvidence.find((item) => isImageEvidence(item));
            if (thumbnail != null) return thumbnail;
        }
        return undefined;
    }

    private parseEvidence(analysis: unknown): EvidenceItem[] {
        const result = analysisSchema.safeParse(analysis);
        if (result.success) return result.data.evidence ?? [];

        this.logger.debug("Failed to parse issue analysis evidence", { error: result.error });
        return [];
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
                application: { select: { id: true, name: true, slug: true } },
                evidence: {
                    select: {
                        firstSeenAt: true,
                        lastSeenAt: true,
                        testCase: { select: { id: true, name: true, slug: true } },
                    },
                    orderBy: { lastSeenAt: "desc" },
                },
                issues: {
                    select: bugDetailIssueSummarySelect,
                    orderBy: { createdAt: "desc" },
                },
            },
        });

        if (bug == null) throw new NotFoundError();

        const latestEvidenceIssue = await this.db.issue.findFirst({
            where: {
                bugId: bug.id,
                OR: [{ runReview: { isNot: null } }, { generationReview: { isNot: null } }],
            },
            select: bugDetailLatestOccurrenceIssueSelect,
            orderBy: { createdAt: "desc" },
        });

        const blocks = await buildBugDetailBlocks(this.db, bug.issues, latestEvidenceIssue, this.storageProvider);

        return {
            id: bug.id,
            status: bug.status,
            title: bug.title,
            description: bug.description,
            severity: bug.severity,
            firstSeenAt: bug.firstSeenAt,
            lastSeenAt: bug.lastSeenAt,
            resolvedAt: bug.resolvedAt,
            application: bug.application,
            testCases: bug.evidence.map((e) => ({
                ...e.testCase,
                firstSeenAt: e.firstSeenAt,
                lastSeenAt: e.lastSeenAt,
            })),
            latestOccurrence: blocks.latestOccurrence,
            occurrences: blocks.occurrences,
            issues: blocks.issues,
        };
    }

    async resolveBug(bugId: string, organizationId: string) {
        this.logger.info("Resolving bug", { bugId, organizationId });

        const bug = await this.db.bug.findFirst({
            where: { id: bugId, organizationId },
            select: { id: true, status: true },
        });

        if (bug == null) throw new NotFoundError();
        if (bug.status === "resolved") return;

        await this.db.bug.update({
            where: { id: bugId },
            data: { status: "resolved", resolvedAt: new Date() },
        });

        this.logger.info("Bug resolved", { bugId });
    }

    async reopenBug(bugId: string, organizationId: string) {
        this.logger.info("Reopening bug", { bugId, organizationId });

        const bug = await this.db.bug.findFirst({
            where: { id: bugId, organizationId },
            select: { id: true, status: true },
        });

        if (bug == null) throw new NotFoundError();
        if (bug.status === "open") return;

        await this.db.bug.update({
            where: { id: bugId },
            data: { status: "open", resolvedAt: null },
        });

        this.logger.info("Bug reopened", { bugId });
    }

    isClassificationEnabled(): boolean {
        const enabled = this.analytics.isEnabled();
        this.logger.info("Reporting bug classification availability", { enabled });
        return enabled;
    }

    async classifyBug(bugId: string, organizationId: string, userId: string, verdict: BugVerdict) {
        this.logger.info("Classifying bug", { bugId, organizationId, userId, verdict });

        const bug = await this.db.bug.findFirst({
            where: { id: bugId, organizationId },
            select: {
                id: true,
                severity: true,
                status: true,
                applicationId: true,
                application: { select: { slug: true } },
            },
        });

        if (bug == null) throw new NotFoundError();

        const bugUrl = `${this.appUrl}/app/${bug.application.slug}/bugs/${bug.id}`;

        this.analytics.capture(userId, "bug.classified", {
            bugId: bug.id,
            verdict,
            applicationId: bug.applicationId,
            organizationId,
            severity: bug.severity,
            status: bug.status,
            bugUrl,
        });

        this.logger.info("Bug classified", { bugId, verdict });
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
