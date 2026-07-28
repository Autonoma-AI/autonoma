import { FalsePositiveCandidateSource, type PrismaClient } from "@autonoma/db";
import { type Logger, logger } from "@autonoma/logger";
import type { BranchesService } from "../routes/branches/branches.service";

/**
 * A false-positive candidate reported through the debug MCP `report_false_positive` tool: the caller names a
 * finding on a PR; we resolve the PR's latest investigation report and match the id against the findings the
 * caller actually saw.
 */
export interface McpFalsePositiveReport {
    organizationId: string;
    applicationId: string;
    repoFullName: string;
    prNumber: number;
    /** The finding id from `get_investigation` - equal to the DB row's `findingKey`, scoped to the report snapshot. */
    findingId: string;
    /** The MCP caller's user id, stored as the candidate's reporter (`reportedBy`). */
    reportedBy: string;
    reason?: string;
}

/**
 * The outcome of {@link FalsePositiveCandidateService.reportFromMcp}. `recorded` means a candidate row was
 * written; `no_report` means the PR has no renderable investigation report yet (nothing to report against);
 * `finding_not_found` means the id didn't match any finding in the latest report (e.g. it named a finding from an
 * older push) - the caller gets the known ids back so it can retry. Only `recorded` writes a row.
 */
export type McpFalsePositiveResult =
    | { status: "recorded"; snapshotId: string; findingKey: string }
    | { status: "no_report" }
    | { status: "finding_not_found"; knownFindingIds: string[] };

/** The open findings on a skipped head, plus who skipped and why - the raw material for skip_reason candidates. */
export interface SkipReasonFalsePositives {
    organizationId: string;
    repoFullName: string;
    prNumber: number;
    snapshotId: string;
    findingKeys: string[];
    /** The `/autonoma-skip` GitHub actor login, stored as the candidate's reporter (`reportedBy`). */
    reportedBy: string;
    reason: string;
}

/**
 * Owns the false-positive-candidate store (`FindingFalsePositiveCandidate`) - the tracking signal fed by two
 * channels: the client's own coding agent via the debug MCP tool (primary), and an FP-indicating `/autonoma-skip`
 * reason (secondary). This is tracking data ONLY: writing a candidate never confirms a false positive, re-derives
 * a verdict, unblocks a check, or hides a finding. A candidate is keyed to `(snapshotId, findingKey)` because
 * findings are recreated per push, so a findingKey is stable only within one snapshot's report.
 */
export class FalsePositiveCandidateService {
    private readonly logger: Logger;

    constructor(
        private readonly db: PrismaClient,
        private readonly branches: BranchesService,
    ) {
        this.logger = logger.child({ name: this.constructor.name });
    }

    /**
     * Record a false-positive candidate reported via the debug MCP. Resolves the PR's latest investigation report
     * the same way `get_investigation` does and matches `findingId` against the findings the caller saw. Writes one
     * candidate on a match; on an unknown id or a PR with no report it writes nothing and returns the reason so the
     * tool can tell the caller.
     */
    async reportFromMcp(report: McpFalsePositiveReport): Promise<McpFalsePositiveResult> {
        this.logger.info("Recording MCP false-positive candidate", {
            organizationId: report.organizationId,
            extra: { repoFullName: report.repoFullName, prNumber: report.prNumber, findingId: report.findingId },
        });

        const resolved = await this.branches.resolveInvestigationFindingKeysForPr(
            report.applicationId,
            report.prNumber,
            report.organizationId,
        );
        if (resolved == null) {
            this.logger.info("MCP false-positive candidate: no investigation report for PR", {
                organizationId: report.organizationId,
                extra: { repoFullName: report.repoFullName, prNumber: report.prNumber },
            });
            return { status: "no_report" };
        }

        if (!resolved.findingKeys.includes(report.findingId)) {
            this.logger.info("MCP false-positive candidate: finding id not in latest report", {
                organizationId: report.organizationId,
                extra: {
                    repoFullName: report.repoFullName,
                    prNumber: report.prNumber,
                    findingId: report.findingId,
                },
            });
            return { status: "finding_not_found", knownFindingIds: resolved.findingKeys };
        }

        await this.db.findingFalsePositiveCandidate.create({
            data: {
                organizationId: report.organizationId,
                repoFullName: report.repoFullName,
                prNumber: report.prNumber,
                snapshotId: resolved.snapshotId,
                findingKey: report.findingId,
                source: FalsePositiveCandidateSource.mcp_client_agent,
                reportedBy: report.reportedBy,
                reason: report.reason,
            },
        });
        this.logger.info("MCP false-positive candidate recorded", {
            organizationId: report.organizationId,
            extra: {
                repoFullName: report.repoFullName,
                prNumber: report.prNumber,
                snapshotId: resolved.snapshotId,
                findingKey: report.findingId,
            },
        });
        return { status: "recorded", snapshotId: resolved.snapshotId, findingKey: report.findingId };
    }

    /**
     * Record one skip_reason candidate per open finding on a skipped head, when the skip reason indicated a false
     * positive. The caller (the merge gate) has already decided the reason claims an FP and passes the open-bug
     * snapshot it captured for the skip. Returns the number of candidates written (zero when the head had no open
     * findings).
     */
    async recordFromSkipReason(params: SkipReasonFalsePositives): Promise<number> {
        this.logger.info("Recording skip-reason false-positive candidates", {
            organizationId: params.organizationId,
            extra: {
                repoFullName: params.repoFullName,
                prNumber: params.prNumber,
                snapshotId: params.snapshotId,
                findingCount: params.findingKeys.length,
            },
        });
        if (params.findingKeys.length === 0) return 0;

        const result = await this.db.findingFalsePositiveCandidate.createMany({
            data: params.findingKeys.map((findingKey) => ({
                organizationId: params.organizationId,
                repoFullName: params.repoFullName,
                prNumber: params.prNumber,
                snapshotId: params.snapshotId,
                findingKey,
                source: FalsePositiveCandidateSource.skip_reason,
                reportedBy: params.reportedBy,
                reason: params.reason,
            })),
        });
        this.logger.info("Skip-reason false-positive candidates recorded", {
            organizationId: params.organizationId,
            extra: { repoFullName: params.repoFullName, prNumber: params.prNumber, count: result.count },
        });
        return result.count;
    }
}
