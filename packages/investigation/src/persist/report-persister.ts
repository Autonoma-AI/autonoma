import type { Prisma, PrismaClient } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import type { InvestigationReportData } from "@autonoma/types";

/** Everything the persister needs beyond the report data itself: where it belongs and the markdown mirror key. */
export interface PersistReportInput {
    snapshotId: string;
    organizationId: string;
    data: InvestigationReportData;
    /** Legacy S3 markdown key, passed only by the backfill for pre-island reports; undefined for new reports. */
    s3Key?: string;
}

/**
 * Persists the investigation agent's structured report into its queryable native tables (the "island":
 * InvestigationReport + InvestigationFinding / InvestigationSuggestedTest). This is the source-of-truth write
 * the API reads back - it replaces the old S3 report entirely. Media stays as s3:// keys on the finding rows
 * (the API signs them on read); display-only blobs (evidence, run trace) are stored as JSON columns.
 *
 * Idempotent: a re-run of the same snapshot upserts the parent and REPLACES all children, so the row set
 * always reflects the latest run. The whole write is one transaction - a report is never half-persisted.
 */
export class InvestigationReportPersister {
    private readonly logger: Logger;

    constructor(private readonly db: PrismaClient) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    async persist(input: PersistReportInput): Promise<void> {
        const { snapshotId, organizationId, data, s3Key } = input;
        this.logger.info("Persisting investigation report to the island tables", {
            snapshot: { snapshotId },
            extra: { findings: data.findings.length, suggested: data.suggested.length },
        });

        const clientBugCount = data.findings.filter((finding) => finding.category === "client_bug").length;

        await this.db.$transaction(async (tx) => {
            await tx.investigationReport.upsert({
                where: { snapshotId },
                create: {
                    snapshotId,
                    organizationId,
                    status: "completed",
                    ...this.reportFields(data, s3Key, clientBugCount),
                },
                update: {
                    status: "completed",
                    // Literal null (not undefined) is required to CLEAR these on Prisma - a completed report has no
                    // in-flight stage, so a re-run that finishes must wipe any stage the progress step left behind.
                    stage: null,
                    stageUpdatedAt: null,
                    ...this.reportFields(data, s3Key, clientBugCount),
                },
            });

            // Replace children wholesale: a re-run's row set always mirrors the latest classification.
            await tx.investigationFinding.deleteMany({ where: { reportSnapshotId: snapshotId } });
            await tx.investigationSuggestedTest.deleteMany({ where: { reportSnapshotId: snapshotId } });

            if (data.findings.length > 0) {
                await tx.investigationFinding.createMany({
                    data: data.findings.map((finding, index) =>
                        this.findingRow(snapshotId, organizationId, finding, index),
                    ),
                });
            }
            if (data.suggested.length > 0) {
                await tx.investigationSuggestedTest.createMany({
                    data: data.suggested.map((test, index) => ({
                        reportSnapshotId: snapshotId,
                        organizationId,
                        name: test.name,
                        instruction: test.instruction,
                        reasoning: test.reasoning,
                        validationPassed: test.validation?.passed,
                        validationIterations: test.validation?.iterations,
                        validationFailureReason: test.validation?.failureReason,
                        displayOrder: index,
                    })),
                });
            }
        });

        this.logger.info("Investigation report persisted", { snapshot: { snapshotId }, extra: { clientBugCount } });
    }

    /** The denormalized header + counts written on both the create and update branches of the parent upsert. */
    private reportFields(data: InvestigationReportData, s3Key: string | undefined, clientBugCount: number) {
        return {
            s3Key,
            testCount: data.findings.length,
            clientBugCount,
            client: data.client,
            appSlug: data.appSlug,
            prNumber: data.prNumber,
            prTitle: data.prTitle,
            prBody: data.prBody,
            repoFullName: data.repoFullName,
            commitSha: data.commitSha,
            // Sticky: undefined SKIPS the column on Prisma, so a re-run that produced no deployed-agent comparison
            // keeps the last one rather than clearing it. That is intended - the comparison is a supplementary
            // display blob (near-always reloaded each run), so retaining the prior one on a transient miss is
            // harmless and better than showing nothing.
            deployed: data.deployed ?? undefined,
        };
    }

    private findingRow(
        snapshotId: string,
        organizationId: string,
        finding: InvestigationReportData["findings"][number],
        index: number,
    ): Prisma.InvestigationFindingCreateManyInput {
        return {
            reportSnapshotId: snapshotId,
            organizationId,
            findingKey: finding.id,
            slug: finding.slug,
            category: finding.category,
            confidence: finding.confidence,
            planFidelity: finding.planFidelity,
            falsePositiveRisk: finding.falsePositiveRisk,
            headline: finding.headline,
            whatHappened: finding.whatHappened,
            observedAppIssues: finding.observedAppIssues,
            remediation: finding.remediation,
            rootCause: finding.rootCause,
            suggestedFixDiff: finding.suggestedFixDiff,
            plan: finding.plan,
            runSuccess: finding.runSuccess,
            stepCount: finding.stepCount,
            runSteps: finding.runSteps,
            runTrace: finding.runTrace,
            evidence: finding.evidence,
            // In InvestigationReportData these carry the raw s3:// keys (the API signs them on read), not URLs.
            videoKey: finding.videoUrl,
            screenshotKey: finding.finalScreenshotUrl,
            error: finding.error,
            // Set only on a MERGED finding: the tests it now represents (its own slug + the absorbed ones).
            coveredSlugs: finding.coveredSlugs,
            displayOrder: index,
        };
    }
}
