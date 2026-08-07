import {
    aggregateSnapshotHealth,
    authoritativeSnapshotHealth,
    buildAuthoritativeCheckpointSummary,
    buildCheckpointSummary,
    computeSnapshotHealth,
    listExecutedTestsForSnapshot,
    loadAuthoritativeCheckpointInputs,
} from "@autonoma/checkpoint";
import type { PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import type { Logger } from "@autonoma/logger";
import type { SnapshotReport } from "@autonoma/types";
import type { GitHubInstallationService } from "../../github/github-installation.service";
import { buildResultsBlock } from "./snapshot-report-results";
import { buildTriggerBlock } from "./snapshot-report-trigger";

export async function loadSnapshotReport({
    db,
    github,
    snapshotId,
    organizationId,
    parentLogger,
}: {
    db: PrismaClient;
    github: GitHubInstallationService;
    snapshotId: string;
    organizationId: string;
    parentLogger: Logger;
}): Promise<SnapshotReport> {
    const logger = parentLogger.child({ name: "loadSnapshotReport" });
    logger.info("Loading snapshot report", { snapshotId });

    const snapshot = await db.branchSnapshot.findUnique({
        where: { id: snapshotId, branch: { organizationId } },
        select: {
            id: true,
            status: true,
            source: true,
            headSha: true,
            baseSha: true,
            createdAt: true,
            branch: {
                select: {
                    id: true,
                    name: true,
                    applicationId: true,
                    prInfo: { select: { prNumber: true } },
                },
            },
        },
    });

    if (snapshot == null) throw new NotFoundError("Snapshot not found");

    const healthMap = await aggregateSnapshotHealth(db, [{ id: snapshot.id, status: snapshot.status }], logger);
    const healthEntry = healthMap.get(snapshot.id);
    const healthCounts = healthEntry?.counts ?? {
        failing: 0,
        passing: 0,
        running: 0,
        setupFailed: 0,
        notAffected: 0,
        totalTests: 0,
    };
    const [trigger, executedTests, authoritativeBySnapshot] = await Promise.all([
        buildTriggerBlock({ snapshot, github, organizationId, logger }),
        listExecutedTestsForSnapshot(db, snapshotId),
        loadAuthoritativeCheckpointInputs(db, organizationId, [snapshotId], logger),
    ]);
    const results = buildResultsBlock(executedTests, logger);
    const authoritative = authoritativeBySnapshot.get(snapshotId);
    // An authoritative snapshot's header badge derives from the AnalysisReport verdict, not the legacy health
    // model the merged pipeline never populates.
    const health =
        authoritative != null
            ? authoritativeSnapshotHealth(authoritative)
            : (healthEntry?.health ?? computeSnapshotHealth(snapshot.status, healthCounts));

    const summary =
        authoritative != null
            ? buildAuthoritativeCheckpointSummary({
                  jobStatus: authoritative.jobStatus,
                  findingBuckets: authoritative.findingBuckets,
                  bugCount: authoritative.bugCount,
                  totalTests: healthCounts.totalTests,
              })
            : buildCheckpointSummary({ snapshotStatus: snapshot.status, counts: healthCounts });

    logger.info("Snapshot report assembled", { snapshotId, filesChanged: trigger.filesChanged.length });

    return {
        snapshot: {
            id: snapshot.id,
            status: snapshot.status,
            source: snapshot.source,
            headSha: snapshot.headSha ?? undefined,
            baseSha: snapshot.baseSha ?? undefined,
            createdAt: snapshot.createdAt,
            branch: {
                id: snapshot.branch.id,
                name: snapshot.branch.name,
                prNumber: snapshot.branch.prInfo?.prNumber,
            },
        },
        trigger,
        results,
        health,
        healthCounts,
        summary,
    };
}
