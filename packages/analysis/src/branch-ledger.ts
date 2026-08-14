import type { Prisma, PrismaClient } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import {
    type AnalysisIssueKind,
    type AnalysisIssueStatus,
    type AnalysisVerdictCounts,
    type AnalysisVerdictSummary,
    type RunPlaneSummary,
    analysisIssueKindSchema,
    analysisIssueStatusSchema,
} from "@autonoma/types";
import { readPlaneSummary } from "./queries/finding-coverage";
import { type Issue, issueStatusFilter, readIssues } from "./queries/read-issues";
import { type AnalysisLifecycle, lifecycleSelect, toLifecycle } from "./queries/read-lifecycle";
import { type SettledReport, readLatestSettledReport } from "./queries/read-report";
import { derivePrVerdict } from "./verdict";

export interface IssueFilter {
    status?: AnalysisIssueStatus;
    kind?: AnalysisIssueKind;
}

export interface CoveredIssue {
    issueId: string;
    title: string;
    coveredTests: { testCaseId: string; slug: string }[];
}

export interface PriorReport {
    snapshotId: string;
    reportMarkdown: string;
}

/**
 * The read side of the branch's issue ledger. Accepts a transaction client so a settlement can read it inside
 * the transaction that writes it; every method is a plain read.
 *
 * Obtained via `AnalysisStore.forBranch` or `Analysis.branch`, never constructed directly.
 */
export class BranchLedger {
    private readonly logger: Logger;

    constructor(
        private readonly db: PrismaClient | Prisma.TransactionClient,
        public readonly branchId: string,
    ) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    /**
     * The branch's issues, in the canonical list order every surface renders (see {@link readIssues}). Unfiltered
     * it returns open AND resolved rows: the Reporter reconciles against both (a regression reopens a resolved
     * issue), and the PR page links resolved ones.
     */
    public async issues(filter?: IssueFilter): Promise<Issue[]> {
        const issues = await readIssues(this.db, {
            branchId: this.branchId,
            resolvedAt: filter?.status != null ? issueStatusFilter(filter.status) : undefined,
            // Kind is authored content, on the issue's current version.
            currentVersion: filter?.kind != null ? { kind: filter.kind } : undefined,
        });
        this.logger.info("Loaded branch issues", {
            branch: { branchId: this.branchId },
            extra: { count: issues.length, filter },
        });
        return issues;
    }

    public async openIssues(filter?: { kind?: AnalysisIssueKind }): Promise<Issue[]> {
        return this.issues({ status: analysisIssueStatusSchema.enum.open, kind: filter?.kind });
    }

    /** Counted by the kind enum's exact string, so a malformed row can never block a PR. */
    public async openBugCount(): Promise<number> {
        return this.db.analysisIssue.count({
            where: {
                branchId: this.branchId,
                resolvedAt: issueStatusFilter(analysisIssueStatusSchema.enum.open),
                currentVersion: { kind: analysisIssueKindSchema.enum.bug },
            },
        });
    }

    /** Open bug issues with their derived covered-test set - the re-verification input. */
    public async coveredTestsForOpenBugs(): Promise<CoveredIssue[]> {
        const issues = await this.openIssues({ kind: analysisIssueKindSchema.enum.bug });
        return issues.map((issue) => {
            const byTestCaseId = new Map<string, { testCaseId: string; slug: string }>();
            for (const finding of issue.coveredFindings) {
                byTestCaseId.set(finding.testCaseId, { testCaseId: finding.testCaseId, slug: finding.slug });
            }
            return { issueId: issue.id, title: issue.title, coveredTests: [...byTestCaseId.values()] };
        });
    }

    /**
     * What this PR reads as - the one answer the GitHub comment, the merge-gate check, the PR page and MCP render.
     *
     * `bugCount` is the branch's live open bug issues, so the verdict is cumulative: a bug found two commits ago
     * and never fixed still counts. The coverage half is only the newest run's, so it describes the latest commit
     * rather than the whole PR.
     */
    public async verdict(): Promise<AnalysisVerdictSummary> {
        const [bugCount, report] = await Promise.all([this.openBugCount(), this.latestReport()]);
        return this.deriveVerdict(bugCount, report);
    }

    /**
     * The verdict AND the open bug issues behind it, read together. The two callers that need both - the merge-gate
     * check and the PR comment - would otherwise count the open bugs (inside {@link verdict}) and list them
     * separately, reading the same rows twice and risking a count/list disagreement under a concurrent settlement.
     * The issues arrive in the ledger's canonical order.
     *
     * `knownRunPlane` lets a caller that already computed a run's plane summary hand it in; it is reused only when
     * it is the very run the verdict resolves against (the branch's latest report), so the comment path does not
     * summarize the same snapshot's findings twice.
     */
    public async verdictWithOpenBugs(knownRunPlane?: {
        snapshotId: string;
        summary: RunPlaneSummary;
    }): Promise<{ verdict: AnalysisVerdictSummary; openBugs: Issue[] }> {
        const [openBugs, report] = await Promise.all([
            this.openIssues({ kind: analysisIssueKindSchema.enum.bug }),
            this.latestReport(),
        ]);
        const verdict = await this.deriveVerdict(openBugs.length, report, knownRunPlane);
        return { verdict, openBugs };
    }

    private async deriveVerdict(
        bugCount: number,
        report: SettledReport | undefined,
        knownRunPlane?: { snapshotId: string; summary: RunPlaneSummary },
    ): Promise<AnalysisVerdictSummary> {
        const latestRun = await this.resolveRunPlane(report, knownRunPlane);
        const counts: AnalysisVerdictCounts = {
            bugCount,
            coverageGapCount: latestRun?.coverage.total ?? 0,
            investigatedCount: latestRun?.testCount ?? 0,
        };
        // The flow itemization is the better reading when the Reporter authored one, because it spans the branch
        // rather than the newest run; the counts are the fallback for a report written before it.
        const state = derivePrVerdict({
            flows: report?.flows ?? [],
            openBugCount: counts.bugCount,
            investigatedCount: counts.investigatedCount,
            coverageGapCount: counts.coverageGapCount,
        });
        this.logger.info("Resolved branch verdict", {
            branch: { branchId: this.branchId },
            extra: { ...counts, state, flows: report?.flows.length ?? 0 },
        });
        return {
            state,
            bugCount: counts.bugCount,
            coverageGapCount: counts.coverageGapCount,
            investigatedCount: counts.investigatedCount,
        };
    }

    /** The plane summary of the report's run: the caller's if it is for that same run, else read fresh. */
    private async resolveRunPlane(
        report: SettledReport | undefined,
        known?: { snapshotId: string; summary: RunPlaneSummary },
    ): Promise<RunPlaneSummary | undefined> {
        if (report == null) return undefined;
        if (known?.snapshotId === report.snapshotId) return known.summary;
        return readPlaneSummary(this.db, report.snapshotId);
    }

    /** The branch's newest settled report by run open time, or undefined when no run on it ever settled. */
    public async latestReport(): Promise<SettledReport | undefined> {
        return readLatestSettledReport(this.db, this.branchId);
    }

    /**
     * The newest analysis lifecycle on the branch, which answers "is a run going, and how did the last one end"
     * even before any report exists.
     */
    public async latestLifecycle(): Promise<(AnalysisLifecycle & { snapshotCreatedAt: Date }) | undefined> {
        const job = await this.db.analysisJob.findFirst({
            where: { snapshot: { branchId: this.branchId } },
            orderBy: { snapshot: { createdAt: "desc" } },
            select: { ...lifecycleSelect, snapshot: { select: { createdAt: true } } },
        });
        if (job == null) return undefined;
        return { ...toLifecycle(job), snapshotCreatedAt: job.snapshot.createdAt };
    }

    /**
     * The branch's most recent report proses, excluding the given snapshot's own. Empty proses (rows predating
     * the Reporter authoring one) are excluded.
     */
    public async priorReports(input: { excludeSnapshotId: string; limit: number }): Promise<PriorReport[]> {
        const rows = await this.db.analysisReport.findMany({
            where: {
                snapshot: { branchId: this.branchId },
                reportMarkdown: { not: "" },
                NOT: { snapshotId: input.excludeSnapshotId },
            },
            orderBy: { createdAt: "desc" },
            take: input.limit,
            select: { snapshotId: true, reportMarkdown: true },
        });
        return rows.map((row) => ({ snapshotId: row.snapshotId, reportMarkdown: row.reportMarkdown }));
    }
}
