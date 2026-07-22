import {
    aggregateSnapshotHealth,
    authoritativeSnapshotHealth,
    buildAuthoritativeCheckpointSummary,
    buildCheckpointSummary,
    computeSnapshotHealth,
    countOpenBugsBySnapshot,
    listExecutedTestsForSnapshot,
    loadAuthoritativeCheckpointInputs,
} from "@autonoma/checkpoint";
import type { PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import type { Logger } from "@autonoma/logger";
import type { StorageProvider } from "@autonoma/storage";
import type { SnapshotReport, SnapshotReportSelectedTest } from "@autonoma/types";
import type { GitHubInstallationService } from "../../github/github-installation.service";
import { loadFirstIterationReasoning } from "./first-iteration-reasoning";
import { loadBugsForSnapshot } from "./snapshot-report-bugs";
import { buildResultsBlock } from "./snapshot-report-results";
import { buildTriggerBlock } from "./snapshot-report-trigger";

export async function loadSnapshotReport({
    db,
    github,
    storageProvider,
    snapshotId,
    organizationId,
    parentLogger,
}: {
    db: PrismaClient;
    github: GitHubInstallationService;
    storageProvider: StorageProvider;
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
            diffsJob: {
                select: {
                    analysisReasoning: true,
                    affectedTests: {
                        select: {
                            affectedReason: true,
                            reasoning: true,
                            testCase: { select: { id: true, name: true, slug: true } },
                        },
                        orderBy: { createdAt: "asc" },
                    },
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
    const [trigger, executedTests, bugs, firstIterationReasoning, openBugCountBySnapshot, authoritativeBySnapshot] =
        await Promise.all([
            buildTriggerBlock({ snapshot, github, organizationId, logger }),
            listExecutedTestsForSnapshot(db, snapshotId),
            loadBugsForSnapshot(db, snapshotId, storageProvider, logger),
            loadFirstIterationReasoning(db, snapshotId, logger),
            countOpenBugsBySnapshot(db, [snapshotId]),
            loadAuthoritativeCheckpointInputs(db, organizationId, [snapshotId], logger),
        ]);
    const results = buildResultsBlock(executedTests, logger);
    const authoritative = authoritativeBySnapshot.get(snapshotId);
    // An authoritative snapshot's header badge derives from the AnalysisReport verdict, not the legacy health/Bug
    // model the merged pipeline never populates.
    const health =
        authoritative != null
            ? authoritativeSnapshotHealth(authoritative)
            : (healthEntry?.health ?? computeSnapshotHealth(snapshot.status, healthCounts));

    const selected: SnapshotReportSelectedTest[] = (snapshot.diffsJob?.affectedTests ?? []).map((t) => ({
        testCaseId: t.testCase.id,
        name: t.testCase.name,
        slug: t.testCase.slug,
        affectedReason: t.affectedReason ?? undefined,
        reasoning: t.reasoning ?? undefined,
    }));

    const openBugs = bugs.filter((b) => b.status === "open");
    const issueOccurrenceCount = openBugs.reduce((sum, b) => sum + b.occurrences, 0);
    // Open-bug count comes from the shared `countOpenBugsBySnapshot` (the same
    // source the PR list and GitHub comment use) so the report agrees with them.
    const openBugCount = openBugCountBySnapshot.get(snapshotId) ?? 0;
    const summary =
        authoritative != null
            ? buildAuthoritativeCheckpointSummary({
                  jobStatus: authoritative.jobStatus,
                  findingBuckets: authoritative.findingBuckets,
                  totalTests: healthCounts.totalTests,
              })
            : buildCheckpointSummary({
                  snapshotStatus: snapshot.status,
                  counts: healthCounts,
                  openBugCount,
                  issueOccurrenceCount,
                  failingByKind: healthEntry?.failingByKind ?? { engine: 0, app: 0 },
              });

    logger.info("Snapshot report assembled", {
        snapshotId,
        selectedTests: selected.length,
        bugs: bugs.length,
        filesChanged: trigger.filesChanged.length,
    });

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
        selection: {
            totalSuiteTests: healthCounts.totalTests,
            selected,
            analysisReasoning: snapshot.diffsJob?.analysisReasoning ?? undefined,
        },
        results,
        bugs,
        firstIterationReasoning,
        health,
        healthCounts,
        summary,
    };
}
