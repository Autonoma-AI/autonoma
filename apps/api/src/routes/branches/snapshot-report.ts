import { AnalysisStore } from "@autonoma/analysis";
import type { PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import type { Logger } from "@autonoma/logger";
import { aggregateSnapshotHealth, computeSnapshotHealth, listExecutedTestsForSnapshot } from "@autonoma/test-suite";
import type { SnapshotReport } from "@autonoma/types";
import type { GitHubInstallationService } from "../../github/github-installation.service";
import { presentCheckpoint } from "./checkpoint-presentation";
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
    const [trigger, executedTests, lifecycles] = await Promise.all([
        buildTriggerBlock({ snapshot, github, organizationId, logger }),
        listExecutedTestsForSnapshot(db, snapshotId),
        new AnalysisStore(db).lifecycles([snapshotId], { organizationId }),
    ]);
    const results = buildResultsBlock(executedTests, logger);
    const healthResult = healthEntry ?? {
        health: computeSnapshotHealth(snapshot.status, healthCounts),
        counts: healthCounts,
    };
    const checkpoint = presentCheckpoint({ lifecycle: lifecycles.get(snapshotId), healthResult });

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
        health: checkpoint?.health ?? healthResult.health,
        healthCounts,
        summary: checkpoint?.summary,
    };
}
