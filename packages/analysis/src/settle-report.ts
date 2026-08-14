import type { Prisma } from "@autonoma/db";
import { type PrismaClient } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import {
    type AnalysisFlow,
    ANALYSIS_VERDICT,
    type AnalysisIssueKind,
    type AnalysisIssueSeverity,
    type EvidenceManifestEntry,
    type PrimaryScreenshot,
    type SuspectedCause,
} from "@autonoma/types";
import { BranchLedger } from "./branch-ledger";
import { AnalysisCoverageGapError, AnalysisSnapshotNotFoundError, IssueNotOnBranchError } from "./errors";
import { COVERED_FINDING, loadFindingCategories } from "./queries/finding-coverage";

export interface IssueContent {
    title: string;
    kind: AnalysisIssueKind;
    severity: AnalysisIssueSeverity;
    expectedBehavior?: string;
    actualBehavior: string;
    narrativeMarkdown: string;
    evidenceManifest: EvidenceManifestEntry[];
    suspectedCause?: SuspectedCause;
    primaryScreenshot?: PrimaryScreenshot;
    /** An unknown slug drops out at resolution. */
    coveredTestSlugs: string[];
    /** Resolved to `primaryTestCaseId` at persist. */
    primaryTestSlug: string;
}

/**
 * One reconciliation of the branch ledger. `open` mints a new issue; `carry_forward` re-states an existing
 * issue's content and re-confirms it (the reopen path too); `resolve` closes an existing issue because the named
 * covering test re-ran and passed - the justification is persisted with it.
 */
export type IssueReconciliation =
    | { kind: "open"; content: IssueContent }
    | { kind: "carry_forward"; existingIssueId: string; content: IssueContent }
    | { kind: "resolve"; existingIssueId: string; resolvingTestSlug: string; note: string };

/** The authored content; the header (verdict, counts) is derived here. */
export interface ReportContent {
    /** ~8 words leading the PR page and the comment. "" on a run whose Reporter authored none. */
    title: string;
    /** The branch's cumulative state in 1-3 plain sentences. Stored in the column still named `summary`. */
    headline: string;
    /** Which parts of the app this PR has established and which it has not. */
    flows: AnalysisFlow[];
    reportMarkdown: string;
    evidenceManifest: EvidenceManifestEntry[];
}

export interface ReportSettlement {
    content: ReportContent;
    issues: IssueReconciliation[];
}

export type SettleReportResult =
    | {
          settled: true;
          verdict: string;
          clientBugCount: number;
          testCount: number;
          issuesOpened: number;
          issuesCarried: number;
          issuesResolved: number;
      }
    | {
          /** Nothing was written. `superseded`: the snapshot is no longer live; `already_settled`: a report exists. */
          settled: false;
          reason: "superseded" | "already_settled";
      };

export interface SettleReportTarget {
    db: PrismaClient;
    snapshotId: string;
    branchId: string;
    organizationId: string;
}

/**
 * Settle the Reporter's whole output atomically: apply each issue reconciliation to the branch ledger, attribute
 * the covered findings, derive the run's verdict + counts, and create the report - one transaction, so the
 * report, its verdict and its issues can never disagree.
 *
 * Two guards live INSIDE that transaction, in write order:
 *
 * - Liveness: a lock on the snapshot row, which a concurrent settlement's status flip must wait for. A Reporter
 *   that finishes after a newer push superseded its run must not mutate branch-scoped issues on evidence from a
 *   head the PR no longer contains - the caller gets `superseded` and reports the discard.
 * - Idempotency: the report is born exactly once. Its existence proves a previous settlement committed
 *   (everything commits together), so a retry gets `already_settled` instead of duplicating every opened issue.
 *
 * Refuses to settle (throws {@link AnalysisCoverageGapError}) when a queued test has neither a verdict nor a
 * recorded containment - the report would read as a clean run over a test that silently never got judged.
 */
export async function settleAnalysisReport(
    target: SettleReportTarget,
    settlement: ReportSettlement,
): Promise<SettleReportResult> {
    const { db, snapshotId, branchId, organizationId } = target;
    const logger = rootLogger.child({ name: "settleAnalysisReport" });
    logger.info("Settling the analysis report", {
        snapshot: { snapshotId },
        extra: { reconciliations: settlement.issues.length },
    });

    const result = await db.$transaction(async (tx) => {
        const live = await isSnapshotLive(tx, snapshotId);
        if (!live) return { settled: false, reason: "superseded" } satisfies SettleReportResult;

        const existing = await tx.analysisReport.findUnique({
            where: { snapshotId },
            select: { snapshotId: true },
        });
        if (existing != null) return { settled: false, reason: "already_settled" } satisfies SettleReportResult;

        await assertFullCoverage(tx, snapshotId);

        for (const issue of settlement.issues) {
            await applyReconciliation(tx, target, issue);
        }
        const counts = tallyReconciliations(settlement.issues);

        // Read after the reconciliations, so the verdict reflects this run's issue writes.
        const [categories, openBugCount] = await Promise.all([
            loadFindingCategories(tx, snapshotId),
            new BranchLedger(tx, branchId).openBugCount(),
        ]);
        const verdict = openBugCount > 0 ? ANALYSIS_VERDICT.client_bug : ANALYSIS_VERDICT.passed;

        await tx.analysisReport.create({
            data: {
                snapshotId,
                organizationId,
                title: settlement.content.title,
                headline: settlement.content.headline,
                flows: settlement.content.flows,
                reportMarkdown: settlement.content.reportMarkdown,
                evidenceManifest: settlement.content.evidenceManifest,
            },
        });

        return {
            settled: true,
            verdict,
            clientBugCount: openBugCount,
            testCount: categories.length,
            ...counts,
        } satisfies SettleReportResult;
    });

    if (result.settled) {
        logger.info("Settled the analysis report", { snapshot: { snapshotId }, extra: result });
    } else {
        logger.warn("Discarded the report settlement", { snapshot: { snapshotId }, extra: { reason: result.reason } });
    }
    return result;
}

function tallyReconciliations(issues: IssueReconciliation[]): {
    issuesOpened: number;
    issuesCarried: number;
    issuesResolved: number;
} {
    return {
        issuesOpened: issues.filter((issue) => issue.kind === "open").length,
        issuesCarried: issues.filter((issue) => issue.kind === "carry_forward").length,
        issuesResolved: issues.filter((issue) => issue.kind === "resolve").length,
    };
}

/**
 * Whether the snapshot is still `processing`, read under an exclusive lock on its row. A concurrent settlement's
 * status flip must wait for this transaction to commit - the assertion and the writes it guards are atomic - and
 * a concurrent `settleReport` for the same analysis serializes here, so the loser reads the winner's committed
 * report and reports `already_settled` instead of colliding on the report's primary key.
 */
async function isSnapshotLive(tx: Prisma.TransactionClient, snapshotId: string): Promise<boolean> {
    const rows = await tx.$queryRaw<
        { status: string }[]
    >`SELECT status FROM branch_snapshot WHERE id = ${snapshotId} FOR UPDATE`;
    const row = rows[0];
    if (row == null) throw new AnalysisSnapshotNotFoundError(snapshotId);
    return row.status === "processing";
}

/**
 * Every queued test is guaranteed coverage - its Investigator filed a verdict, or its crash was contained onto
 * the finding's `failure`. Fewer covered findings than queued tests means containment lost one. One-directional:
 * a finding can outlive the generation that produced it (a test the run removed), so MORE findings than queued
 * tests is normal.
 */
async function assertFullCoverage(tx: Prisma.TransactionClient, snapshotId: string): Promise<void> {
    const [generations, covered] = await Promise.all([
        tx.testGeneration.findMany({
            where: { snapshotId },
            select: { testPlan: { select: { testCaseId: true } } },
        }),
        tx.analysisFinding.count({ where: { reportSnapshotId: snapshotId, ...COVERED_FINDING } }),
    ]);
    const queued = new Set(generations.map((generation) => generation.testPlan.testCaseId)).size;
    if (queued > covered) throw new AnalysisCoverageGapError(snapshotId, queued, covered);
}

async function applyReconciliation(
    tx: Prisma.TransactionClient,
    target: SettleReportTarget,
    issue: IssueReconciliation,
): Promise<void> {
    const { snapshotId, branchId, organizationId } = target;
    const logger = rootLogger.child({ name: "applyReconciliation" });
    if (issue.kind === "resolve") {
        const resolvingFinding = await tx.analysisFinding.findFirst({
            where: { reportSnapshotId: snapshotId, testCase: { slug: issue.resolvingTestSlug } },
            select: { id: true },
        });
        if (resolvingFinding == null) {
            logger.warn("A resolve names a test this analysis holds no finding for", {
                snapshot: { snapshotId },
                extra: { issueId: issue.existingIssueId, resolvingTestSlug: issue.resolvingTestSlug },
            });
        }
        await updateIssueOnBranch(tx, issue.existingIssueId, branchId, {
            resolvedAt: new Date(),
            resolvedByFindingId: resolvingFinding?.id,
            resolutionNote: issue.note,
        });
        return;
    }

    // The agent names TESTS by slug; the ledger references them by id. Resolving here is what keeps the issue's
    // coverage a real relation - the set it covers is the findings attributed to it, not a list of strings that
    // can name a test no finding exists for.
    const content = issue.content;
    const covered = await resolveCoveredFindings(tx, snapshotId, content.coveredTestSlugs);
    // Lifecycle stays on the issue; content is minted as an immutable version and pointed at, so a carry-forward
    // appends rather than overwriting the prior restatement. Both literals are TYPED to keep excess-property checking
    // engaged - Prisma's XOR-shaped `data` silently accepts a dropped/renamed column from an inferred spread, so the
    // annotation is what makes a stale column fail at the write. `lifecycle` is a Pick so it also fits the updateMany arm.
    const lifecycle: Pick<
        Prisma.AnalysisIssueUncheckedCreateInput,
        "resolvedAt" | "resolvedByFindingId" | "resolutionNote"
    > = {
        resolvedAt: null,
        resolvedByFindingId: null,
        resolutionNote: null,
    };
    const versionData: Prisma.AnalysisIssueVersionUncheckedCreateWithoutIssueInput = {
        snapshotId,
        organizationId,
        title: content.title,
        kind: content.kind,
        severity: content.severity,
        expectedBehavior: content.expectedBehavior,
        actualBehavior: content.actualBehavior,
        narrativeMarkdown: content.narrativeMarkdown,
        evidenceManifest: content.evidenceManifest,
        primaryScreenshot: content.primaryScreenshot,
        // Undefined when the designated slug resolved to no finding: a carry-forward then keeps the previous
        // designation rather than clearing it.
        primaryTestCaseId: covered.get(content.primaryTestSlug)?.testCaseId,
        suspectedCause: content.suspectedCause,
    };

    if (issue.kind === "open") {
        const created = await tx.analysisIssue.create({ data: { ...lifecycle, branchId, organizationId } });
        const version = await tx.analysisIssueVersion.create({ data: { issueId: created.id, ...versionData } });
        await tx.analysisIssue.update({ where: { id: created.id }, data: { currentVersionId: version.id } });
        await attributeFindings(tx, covered, created.id);
        return;
    }

    // carry_forward: append a fresh restatement, make it current, and reopen the issue if it had been resolved. The
    // version keys on (issue, snapshot) - a snapshot authors at most one restatement of an issue - so if this ever
    // runs twice for the same snapshot the upsert updates in place rather than duplicating (a re-settle is already
    // refused earlier by the report-exists guard). The covered set unions itself: attributing this run's findings
    // adds to the ones earlier snapshots attributed.
    const version = await tx.analysisIssueVersion.upsert({
        where: { issueId_snapshotId: { issueId: issue.existingIssueId, snapshotId } },
        create: { issueId: issue.existingIssueId, ...versionData },
        update: versionData,
    });
    await updateIssueOnBranch(tx, issue.existingIssueId, branchId, { ...lifecycle, currentVersionId: version.id });
    await attributeFindings(tx, covered, issue.existingIssueId);
}

/** Update an issue, scoped to the branch in the `where` - a reconciliation can never touch a foreign issue. */
async function updateIssueOnBranch(
    tx: Prisma.TransactionClient,
    issueId: string,
    branchId: string,
    data: Prisma.AnalysisIssueUncheckedUpdateManyInput,
): Promise<void> {
    const { count } = await tx.analysisIssue.updateMany({ where: { id: issueId, branchId }, data });
    if (count === 0) throw new IssueNotOnBranchError(issueId, branchId);
}

/** An unknown slug drops out. */
async function resolveCoveredFindings(
    tx: Prisma.TransactionClient,
    snapshotId: string,
    slugs: string[],
): Promise<Map<string, { findingId: string; testCaseId: string }>> {
    if (slugs.length === 0) return new Map();
    const rows = await tx.analysisFinding.findMany({
        where: { reportSnapshotId: snapshotId, testCase: { slug: { in: slugs } } },
        select: { id: true, testCaseId: true, testCase: { select: { slug: true } } },
    });
    return new Map(rows.map((row) => [row.testCase.slug, { findingId: row.id, testCaseId: row.testCaseId }]));
}

/** Other snapshots' findings keep their own issue. */
async function attributeFindings(
    tx: Prisma.TransactionClient,
    covered: Map<string, { findingId: string; testCaseId: string }>,
    issueId: string,
): Promise<void> {
    const findingIds = [...covered.values()].map((entry) => entry.findingId);
    if (findingIds.length === 0) return;
    await tx.analysisFinding.updateMany({ where: { id: { in: findingIds } }, data: { issueId } });
}
