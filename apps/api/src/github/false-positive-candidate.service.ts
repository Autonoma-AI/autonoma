import { FalsePositiveCandidateSource, type PrismaClient } from "@autonoma/db";
import { type Logger, logger } from "@autonoma/logger";

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
 * Owns the false-positive-candidate store (`FindingFalsePositiveCandidate`), fed by an FP-indicating
 * `/autonoma-skip` reason. This is tracking data ONLY: writing a candidate never confirms a false positive,
 * re-derives a verdict, unblocks a check, or hides a finding. A candidate is keyed to `(snapshotId, findingKey)`
 * because findings are recreated per push, so a findingKey is stable only within one snapshot's report.
 */
export class FalsePositiveCandidateService {
    private readonly logger: Logger;

    constructor(private readonly db: PrismaClient) {
        this.logger = logger.child({ name: this.constructor.name });
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
