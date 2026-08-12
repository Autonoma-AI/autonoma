import { type Prisma, type PrismaClient } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import type {
    AnalysisClassificationReport,
    AnalysisRunOutcome,
    AnalysisTestOrigin,
    AnalysisVerdict,
    RunPlaneSummary,
} from "@autonoma/types";
import { BranchLedger } from "./branch-ledger";
import { AnalysisSnapshotNotFoundError } from "./errors";
import { type ClientOwnedGap, readClientOwnedGaps } from "./queries/client-owned-gaps";
import { readPlaneSummary } from "./queries/finding-coverage";
import { type Finding, type FindingIdentity, readFindingIds, readFindings } from "./queries/read-findings";
import { type Issue, readIssues } from "./queries/read-issues";
import { type AnalysisLifecycle, readLifecycle } from "./queries/read-lifecycle";
import { type SettledReport, readSettledReport } from "./queries/read-report";
import { type ReportSettlement, type SettleReportResult, settleAnalysisReport } from "./settle-report";

export interface RecordClassificationInput {
    testCaseId: string;
    /** Set on the finding at its birth; a later write restates rather than revises it. */
    origin?: AnalysisTestOrigin;
    selectionReason?: string;
    /**
     * Which slot of the self-heal loop this outcome occupies, 1-based - the caller's own iteration counter, never
     * derived from what is already stored. It is the write's idempotency key: filing the same slot twice restates
     * that row instead of appending a second one, so a re-execution can never invent a self-heal that never ran.
     */
    number: number;
    generationId: string;
    category: AnalysisVerdict;
    headline: string;
    /** The classifier's full rich output. Absent for a contained scenario/classify fault, which reached no verdict. */
    report?: AnalysisClassificationReport;
}

export interface RecordContainmentInput {
    testCaseId: string;
    origin?: AnalysisTestOrigin;
    selectionReason?: string;
    failure: PrismaJson.AnalysisFindingFailure;
}

/**
 * One analysis - one pass of the pipeline over one snapshot, 1:1 with it.
 *
 * Per-snapshot findings are inert once the snapshot settles, so `recordClassification` / `recordContainment` do
 * not gate on liveness: a superseded run may still record what its Investigators concluded. `settleReport`
 * mutates the branch-scoped ledger, so it does gate, under a lock on the snapshot row.
 *
 * Obtained via `AnalysisStore.open` / `forAnalysis`, never constructed directly.
 */
export class Analysis {
    private readonly logger: Logger;
    private cachedIdentity?: ScopeIdentity;

    constructor(
        private readonly db: PrismaClient,
        public readonly snapshotId: string,
    ) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    /**
     * File one run+classify iteration: find or create the test's finding, record the iteration as its own
     * classification, and repoint the finding at it. Called after every iteration, so a self-heal's superseded
     * verdict stays on disk rather than being overwritten by the pass that follows it. All three writes share
     * one transaction: either half alone reads as a test that was never judged.
     */
    public async recordClassification(input: RecordClassificationInput): Promise<{ findingId: string }> {
        this.logger.info("Recording analysis classification", {
            snapshot: { snapshotId: this.snapshotId },
            extra: { testCaseId: input.testCaseId, number: input.number, category: input.category },
        });
        const { organizationId } = await this.identity();

        const findingId = await this.db.$transaction(async (tx) => {
            const finding = await this.upsertFinding(tx, input, organizationId);
            const fields = buildClassificationFields(input);
            const filed = await tx.analysisClassification.upsert({
                where: { findingId_number: { findingId: finding.id, number: input.number } },
                create: { findingId: finding.id, number: input.number, organizationId, ...fields },
                update: fields,
                select: { id: true },
            });
            await tx.analysisFinding.update({
                where: { id: finding.id },
                data: { currentClassificationId: filed.id },
            });
            return finding.id;
        });

        this.logger.info("Recorded analysis classification", {
            snapshot: { snapshotId: this.snapshotId },
            extra: { findingId, number: input.number },
        });
        return { findingId };
    }

    /**
     * Record an investigation that crashed without judging a run: the finding carries a structured `failure` and,
     * when nothing was filed before the crash, no classification at all. Never touches
     * `currentClassificationId`, so an iteration the child did file before dying stays the run's verdict.
     * Idempotent.
     */
    public async recordContainment(input: RecordContainmentInput): Promise<{ findingId: string }> {
        this.logger.warn("Recording analysis containment", {
            snapshot: { snapshotId: this.snapshotId },
            extra: { testCaseId: input.testCaseId, failure: input.failure },
        });
        const { organizationId } = await this.identity();

        const finding = await this.upsertFinding(this.db, input, organizationId);
        return { findingId: finding.id };
    }

    /** This analysis's findings, contained ones included, slug-ordered. See {@link readFindings}. */
    public async findings(): Promise<Finding[]> {
        return readFindings(this.db, this.snapshotId);
    }

    /**
     * The open, non-bug issues behind this run's client-owned coverage gaps, most actionable first - what the PR
     * comment asks the reader to fix. A narrow read that never loads a finding's run trace or evidence. See
     * {@link readClientOwnedGaps}.
     */
    public async clientOwnedCoverageIssues(): Promise<ClientOwnedGap[]> {
        return readClientOwnedGaps(this.db, this.snapshotId);
    }

    /** The identities of the findings whose current verdict is one of `categories`. See {@link readFindingIds}. */
    public async findingIds(input: {
        categories: readonly string[];
        organizationId?: string;
    }): Promise<FindingIdentity[]> {
        return readFindingIds(this.db, {
            snapshotId: this.snapshotId,
            organizationId: input.organizationId,
            categories: input.categories,
        });
    }

    /**
     * This analysis's `AnalysisJob` row, or undefined for a snapshot the pipeline never analyzed. Its presence
     * is the authoritative predicate; a settled report is a separate, later fact.
     */
    public async lifecycle(): Promise<AnalysisLifecycle | undefined> {
        return readLifecycle(this.db, this.snapshotId);
    }

    /**
     * The issues this analysis opened, carried forward and resolved, derived from the lifecycle window because
     * the settlement persists counts but not identities. An attributed issue born inside the window was opened
     * here, else carried; a branch issue whose `resolvedAt` falls inside it was resolved here.
     */
    public async issueChanges(): Promise<{ opened: Issue[]; carriedForward: Issue[]; resolved: Issue[] }> {
        const [lifecycle, { branchId, snapshotCreatedAt }] = await Promise.all([this.lifecycle(), this.identity()]);
        if (lifecycle == null) return { opened: [], carriedForward: [], resolved: [] };
        // A job that never recorded `startedAt` predates the column; the snapshot's own birth is the honest floor.
        const windowStart = lifecycle.startedAt ?? snapshotCreatedAt;
        const windowEnd = lifecycle.completedAt ?? new Date();

        const [touched, resolved] = await Promise.all([
            readIssues(this.db, { findings: { some: { reportSnapshotId: this.snapshotId } } }),
            readIssues(this.db, {
                branchId,
                resolvedAt: { gte: windowStart, lte: windowEnd },
            }),
        ]);
        return {
            opened: touched.filter((issue) => issue.createdAt >= windowStart),
            carriedForward: touched.filter((issue) => issue.createdAt < windowStart),
            resolved,
        };
    }

    /** The issue ledger of the branch this analysis runs on. */
    public async branch(): Promise<BranchLedger> {
        const { branchId } = await this.identity();
        return new BranchLedger(this.db, branchId);
    }

    /** What the Reporter authored for this analysis, or undefined while none exists. See {@link readSettledReport}. */
    public async report(): Promise<SettledReport | undefined> {
        return readSettledReport(this.db, this.snapshotId);
    }

    /**
     * Whether this analysis has settled - a report row exists, which proves the Reporter ran to completion and
     * reconciled the branch's issues. The cheap existence check to prefer over {@link report} when only presence
     * matters.
     */
    public async isSettled(): Promise<boolean> {
        const row = await this.db.analysisReport.findUnique({
            where: { snapshotId: this.snapshotId },
            select: { snapshotId: true },
        });
        return row != null;
    }

    /**
     * What this run itself found: both verdict planes and their counts, from its findings. Run-scoped throughout -
     * `bugCount` counts findings this run judged, not the branch's open bug issues, which are the ledger's to
     * answer and outlive any one run. See {@link readPlaneSummary}.
     */
    public async planeSummary(): Promise<RunPlaneSummary> {
        return readPlaneSummary(this.db, this.snapshotId);
    }

    /** Settle the Reporter's whole output atomically. See {@link settleAnalysisReport} for its guards. */
    public async settleReport(settlement: ReportSettlement): Promise<SettleReportResult> {
        const { branchId, organizationId } = await this.identity();
        return settleAnalysisReport({ db: this.db, snapshotId: this.snapshotId, branchId, organizationId }, settlement);
    }

    /**
     * Mark this analysis's `AnalysisJob` with the outcome. The conditional update is the compare-and-swap:
     * `false` means another actor already closed it, and the caller must skip its dependent side effects.
     */
    public async close(outcome: AnalysisRunOutcome): Promise<boolean> {
        this.logger.info("Closing the analysis job", {
            snapshot: { snapshotId: this.snapshotId },
            extra: { outcome: outcome.kind },
        });
        const { count } = await this.db.analysisJob.updateMany({
            where: { snapshotId: this.snapshotId, status: "running" },
            data: terminalJobFields(outcome),
        });
        if (count === 0) {
            this.logger.warn("Analysis job was already closed", { snapshot: { snapshotId: this.snapshotId } });
        }
        return count > 0;
    }

    /** The snapshot's own immutable coordinates, resolved once. */
    private async identity(): Promise<ScopeIdentity> {
        if (this.cachedIdentity != null) return this.cachedIdentity;
        const snapshot = await this.db.branchSnapshot.findUnique({
            where: { id: this.snapshotId },
            select: { branchId: true, createdAt: true, branch: { select: { organizationId: true } } },
        });
        if (snapshot == null) throw new AnalysisSnapshotNotFoundError(this.snapshotId);
        this.cachedIdentity = {
            branchId: snapshot.branchId,
            organizationId: snapshot.branch.organizationId,
            snapshotCreatedAt: snapshot.createdAt,
        };
        return this.cachedIdentity;
    }

    /**
     * Find or create the test's finding on this analysis. The per-test facts (origin, selection reason) are
     * settled at selection, so a later write restates rather than revises them; only a containment's `failure`
     * updates an existing row.
     */
    private async upsertFinding(
        client: PrismaClient | Prisma.TransactionClient,
        input: {
            testCaseId: string;
            origin?: AnalysisTestOrigin;
            selectionReason?: string;
            failure?: PrismaJson.AnalysisFindingFailure;
        },
        organizationId: string,
    ): Promise<{ id: string }> {
        return client.analysisFinding.upsert({
            where: {
                reportSnapshotId_testCaseId: { reportSnapshotId: this.snapshotId, testCaseId: input.testCaseId },
            },
            create: {
                reportSnapshotId: this.snapshotId,
                testCaseId: input.testCaseId,
                organizationId,
                origin: input.origin,
                selectionReason: input.selectionReason,
                failure: input.failure,
            },
            update: input.failure == null ? {} : { failure: input.failure },
            select: { id: true },
        });
    }
}

interface ScopeIdentity {
    branchId: string;
    organizationId: string;
    snapshotCreatedAt: Date;
}

/** The classification row's own columns. A contained scenario/classify fault has no classifier output, so every
 * verdict field lands absent. */
function buildClassificationFields(input: RecordClassificationInput) {
    const report = input.report;
    return {
        generationId: input.generationId,
        category: input.category,
        headline: input.headline,
        confidence: report?.confidence,
        expectedBehavior: report?.expectedBehavior,
        actualBehavior: report?.actualBehavior,
        whatHappened: report?.whatHappened,
        planMismatchNote: report?.planMismatchNote,
        invalidTestNote: report?.invalidTestNote,
        observedAppIssues: report?.observedAppIssues,
        remediation: report?.remediation,
        rootCause: report?.rootCause,
        falsePositiveRisk: report?.falsePositiveRisk,
        plan: report?.plan,
        runSuccess: report?.runSuccess,
        stepCount: report?.stepCount,
        runSteps: report?.runSteps,
        runTrace: report?.runTrace,
        evidence: report?.evidence,
        // These carry the raw s3:// keys (the API signs them on read), not URLs.
        videoKey: report?.videoKey,
        optimizedVideoKey: report?.optimizedVideoKey,
        screenshotKey: report?.screenshotKey,
        clipKey: report?.clipKey,
        conversationUrl: report?.conversationUrl,
        error: report?.error,
    };
}

function terminalJobFields(outcome: AnalysisRunOutcome): {
    status: "completed" | "failed";
    failureReason?: string;
    superseded: boolean;
    completedAt: Date;
} {
    const completedAt = new Date();
    if (outcome.kind === "succeeded") return { status: "completed", superseded: false, completedAt };
    // A superseded run and a genuinely failed one both end `failed` - neither completed - so `superseded` is
    // what tells them apart, and only the second is the pipeline's fault.
    return {
        status: "failed",
        failureReason: outcome.reason,
        superseded: outcome.kind === "superseded",
        completedAt,
    };
}
