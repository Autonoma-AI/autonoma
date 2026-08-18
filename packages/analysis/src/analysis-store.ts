import type { Prisma, PrismaClient } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { Analysis } from "./analysis";
import { ApplicationAnalysisFacts } from "./application-analysis";
import { BranchLedger } from "./branch-ledger";
import { type PriorRunsHistory, type PriorRunsQuery, readPriorRuns } from "./queries/prior-runs";
import { type FindingDetailRecord, readFindingDetail } from "./queries/read-finding-detail";
import { type Issue, readIssues } from "./queries/read-issues";
import { type AnalysisLifecycleSummary, readLifecycles } from "./queries/read-lifecycle";

export interface OpenAnalysisInput {
    snapshotId: string;
    organizationId: string;
}

/**
 * The analysis module's entry point. It writes `analysis_job`, `analysis_finding`, `analysis_classification`,
 * `analysis_issue` and `analysis_report`, and never touches an assignment.
 */
export class AnalysisStore {
    private readonly logger: Logger;

    constructor(private readonly db: PrismaClient) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    public forBranch(branchId: string): BranchLedger {
        return new BranchLedger(this.db, branchId);
    }

    /**
     * Open the analysis on a snapshot: create its `AnalysisJob` lifecycle row. Pass `tx` to compose the creation
     * into the caller's transaction, so a snapshot whose job does not exist (it would settle against nothing)
     * can never be observed.
     */
    public async open(input: OpenAnalysisInput, tx?: Prisma.TransactionClient): Promise<Analysis> {
        this.logger.info("Opening an analysis", { snapshot: { snapshotId: input.snapshotId } });
        const client = tx ?? this.db;
        await client.analysisJob.create({
            data: {
                snapshotId: input.snapshotId,
                organizationId: input.organizationId,
                status: "running",
                startedAt: new Date(),
            },
        });
        return this.forAnalysis(input.snapshotId);
    }

    /**
     * The write handle on one analysis. Addressed by snapshot id, never "whatever is pending on the branch", so
     * an activity keeps operating on its own run after a newer trigger replaced the branch's pending snapshot.
     */
    public forAnalysis(snapshotId: string): Analysis {
        return new Analysis(this.db, snapshotId);
    }

    public forApplication(applicationId: string, organizationId: string): ApplicationAnalysisFacts {
        return new ApplicationAnalysisFacts(this.db, applicationId, organizationId);
    }

    /**
     * One finding by id with its full classification history, org-scoped in the where. Addressed by finding id
     * rather than through {@link forAnalysis} because the caller (the per-finding detail read) starts from a URL
     * param and learns the snapshot from the row. Undefined for an unknown or foreign finding.
     */
    public async findingDetail(
        findingId: string,
        options: { organizationId: string },
    ): Promise<FindingDetailRecord | undefined> {
        return readFindingDetail(this.db, { findingId, organizationId: options.organizationId });
    }

    /** One issue by id, org-scoped in the where. Undefined for an unknown, foreign or malformed row. */
    public async issue(issueId: string, options: { organizationId: string }): Promise<Issue | undefined> {
        const issues = await readIssues(this.db, { id: issueId, organizationId: options.organizationId }, { take: 1 });
        return issues[0];
    }

    /**
     * The lifecycles of many snapshots, keyed by snapshot id, in a fixed two queries. Absence from the map means
     * the pipeline never analyzed the snapshot. See {@link readLifecycles}.
     */
    public async lifecycles(
        snapshotIds: string[],
        options: { organizationId: string },
    ): Promise<Map<string, AnalysisLifecycleSummary>> {
        return readLifecycles(this.db, snapshotIds, options.organizationId);
    }

    /**
     * A test's verdict history across the application's past analyses. Application-scoped, not branch-scoped: a
     * test's identity spans branches and the baseline draws on every analysis that judged it. See
     * {@link readPriorRuns}.
     */
    public async priorRuns(query: PriorRunsQuery): Promise<PriorRunsHistory> {
        return readPriorRuns(this.db, query);
    }
}
