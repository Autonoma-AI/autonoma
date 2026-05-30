import type { PostHogAnalytics } from "@autonoma/analytics";
import type { PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import type { StorageProvider } from "@autonoma/storage";
import type { BugVerdict } from "@autonoma/types";
import { Service } from "../service";
import { signEvidenceUrls } from "../sign-evidence-urls";

type EvidenceItem = { type: string; description: string; s3Key?: string };

export class BugsService extends Service {
    constructor(
        private readonly db: PrismaClient,
        private readonly storageProvider: StorageProvider,
        private readonly analytics: PostHogAnalytics,
        private readonly appUrl: string,
    ) {
        super();
    }

    async listBugs(organizationId: string, applicationId?: string, status?: "open" | "resolved" | "regressed") {
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
                    select: {
                        id: true,
                        title: true,
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
            application: bug.application,
            testCases: bug.evidence.map((e) => ({
                ...e.testCase,
                firstSeenAt: e.firstSeenAt,
                lastSeenAt: e.lastSeenAt,
            })),
            issues,
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
