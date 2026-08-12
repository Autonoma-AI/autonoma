import type { PrismaClient, PullRequestCacheState } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { analysisIssueStatusSchema } from "@autonoma/types";
import { type Issue, issueStatusFilter, readIssues } from "./queries/read-issues";

/** An issue's status is its `resolvedAt`; the retired `status` column is never read. */
const OPEN = issueStatusFilter(analysisIssueStatusSchema.enum.open);

/** A snapshot at least one finding landed on. */
export interface RecentAnalysisRun {
    snapshotId: string;
    branchId: string;
    createdAt: Date;
}

export interface VerdictTally {
    category: string;
    selfHealed: boolean;
}

/** The fallback triage grain when no Reporter-authored issues exist. */
export interface RecentFinding {
    findingId: string;
    createdAt: Date;
    branchId: string;
    category?: string;
    headline?: string;
}

/**
 * Analysis facts spanning every branch of one application - the health metrics' grain.
 *
 * Obtained via `AnalysisStore.forApplication`, never constructed directly.
 */
export class ApplicationAnalysisFacts {
    private readonly logger: Logger;

    constructor(
        private readonly db: PrismaClient,
        public readonly applicationId: string,
        public readonly organizationId: string,
    ) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    /**
     * The application's recent runs, newest first. Grouping on findings is what enforces "a run that selected no
     * tests is not a run".
     */
    public async recentRuns(input: { since: Date; limit: number }): Promise<RecentAnalysisRun[]> {
        const groups = await this.db.analysisFinding.groupBy({
            by: ["reportSnapshotId"],
            where: {
                organizationId: this.organizationId,
                createdAt: { gte: input.since },
                job: { snapshot: { branch: { applicationId: this.applicationId } } },
            },
            _max: { createdAt: true },
            orderBy: { _max: { createdAt: "desc" } },
            take: input.limit,
        });
        if (groups.length === 0) return [];

        const snapshots = await this.db.branchSnapshot.findMany({
            where: { id: { in: groups.map((group) => group.reportSnapshotId) } },
            select: { id: true, branchId: true, createdAt: true },
            orderBy: { createdAt: "desc" },
        });
        return snapshots.map((snapshot) => ({
            snapshotId: snapshot.id,
            branchId: snapshot.branchId,
            createdAt: snapshot.createdAt,
        }));
    }

    public async verdictTallies(snapshotIds: string[]): Promise<VerdictTally[]> {
        if (snapshotIds.length === 0) return [];
        const findings = await this.db.analysisFinding.findMany({
            where: { organizationId: this.organizationId, reportSnapshotId: { in: snapshotIds } },
            select: {
                currentClassification: { select: { category: true } },
                _count: { select: { classifications: true } },
            },
        });
        return findings.flatMap((finding) =>
            finding.currentClassification == null
                ? []
                : [
                      {
                          category: finding.currentClassification.category,
                          selfHealed: finding._count.classifications > 1,
                      },
                  ],
        );
    }

    /** How many analyses ran since the instant, and how many genuinely failed - a superseded run did not. */
    public async jobCounts(input: { since: Date }): Promise<{ total: number; genuineFailures: number }> {
        const scope = {
            organizationId: this.organizationId,
            createdAt: { gte: input.since },
            snapshot: { branch: { applicationId: this.applicationId } },
        };
        const [total, genuineFailures] = await Promise.all([
            this.db.analysisJob.count({ where: scope }),
            this.db.analysisJob.count({ where: { ...scope, status: "failed", superseded: false } }),
        ]);
        return { total, genuineFailures };
    }

    /** Open issues older than the cutoff on a branch still in front of somebody: a closed PR is not neglect. */
    public async staleOpenIssueCount(input: {
        olderThan: Date;
        closedPrStates: readonly PullRequestCacheState[];
    }): Promise<number> {
        return this.db.analysisIssue.count({
            where: {
                organizationId: this.organizationId,
                resolvedAt: OPEN,
                createdAt: { lt: input.olderThan },
                branch: { applicationId: this.applicationId },
                NOT: { branch: { prInfo: { prState: { in: [...input.closedPrStates] } } } },
            },
        });
    }

    public async resolvedIssueCount(input: { since: Date }): Promise<number> {
        return this.db.analysisIssue.count({
            where: {
                organizationId: this.organizationId,
                // A `resolvedAt` inside the window IS resolved-this-window; the retired `status` column is not read.
                resolvedAt: { gte: input.since },
                branch: { applicationId: this.applicationId },
            },
        });
    }

    /**
     * Open issues still in front of somebody: on a live pull request, on main, or - bounded by `recentSince` -
     * on a pull request that moved on with findings still open. Oldest first.
     */
    public async openIssuesOnLiveSurfaces(input: { recentSince: Date; limit: number }): Promise<Issue[]> {
        const issues = await readIssues(
            this.db,
            {
                organizationId: this.organizationId,
                resolvedAt: OPEN,
                branch: { applicationId: this.applicationId },
                OR: [
                    { branch: { prInfo: { prState: "open" } } },
                    { branch: { prInfo: { is: null } } },
                    { createdAt: { gte: input.recentSince } },
                ],
            },
            { orderBy: { createdAt: "asc" }, take: input.limit },
        );
        this.logger.info("Loaded open issues on live surfaces", {
            application: { applicationId: this.applicationId },
            extra: { count: issues.length, limit: input.limit },
        });
        return issues;
    }

    /** Recent findings whose current verdict is one of the given categories. */
    public async recentFindings(input: {
        since: Date;
        categories: readonly string[];
        limit: number;
    }): Promise<RecentFinding[]> {
        const findings = await this.db.analysisFinding.findMany({
            where: {
                organizationId: this.organizationId,
                createdAt: { gte: input.since },
                job: { snapshot: { branch: { applicationId: this.applicationId } } },
                currentClassification: { category: { in: [...input.categories] } },
            },
            select: {
                id: true,
                createdAt: true,
                currentClassification: { select: { category: true, headline: true } },
                job: { select: { snapshot: { select: { branchId: true } } } },
            },
            orderBy: { createdAt: "asc" },
            take: input.limit,
        });
        return findings.map((finding) => ({
            findingId: finding.id,
            createdAt: finding.createdAt,
            branchId: finding.job.snapshot.branchId,
            category: finding.currentClassification?.category,
            headline: finding.currentClassification?.headline,
        }));
    }
}
