import { analytics } from "@autonoma/analytics";
import type { PrismaClient } from "@autonoma/db";
import {
    buildMergeGateCheckResult,
    createGitHubCheckRunStore,
    MERGE_GATE_ANALYTICS_GROUP,
    MERGE_GATE_CHECK_NAME,
    MERGE_GATE_EVENT,
} from "@autonoma/github/check";
import { isOnboardingComplete } from "@autonoma/github/comment";
import { logger as rootLogger } from "@autonoma/logger";
import { ANALYSIS_VERDICT, type AnalysisRunOutcome, coverageSummarySchema } from "@autonoma/types";
import { resolvePrMeta } from "../../codebase/pr-meta";
import type { GitHubAccess, SnapshotMeta } from "../../codebase/snapshot-context";
import { isMergeGateEnabledForOrg } from "./merge-gate-enabled";

/** The verdict string the app-health plane files a real client bug under. Anything else is the `passed` plane. */
const CLIENT_BUG = ANALYSIS_VERDICT.client_bug;

/**
 * Merge-gate finalize step: read the persisted `AnalysisReport.verdict` for the run's snapshot, map it to the
 * `Autonoma` check-run conclusion, and post/update the check.
 * Gated OFF by default: the global `MERGE_GATE_ENABLED` switch AND the org's `mergeGateEnabled` (which itself requires `analysisEnabled`).
 */
export async function concludeMergeGate({
    db,
    github,
    meta,
    outcome,
}: {
    db: PrismaClient;
    github: GitHubAccess;
    meta: SnapshotMeta;
    outcome: AnalysisRunOutcome;
}): Promise<{ status: "posted" | "skipped"; conclusion?: "success" | "failure" | "neutral" }> {
    const logger = rootLogger.child({ name: "concludeMergeGate", snapshotId: meta.snapshotId });
    logger.info("Applying merge-gate verdict");

    if (!(await isMergeGateEnabledForOrg(meta.organizationId))) {
        logger.info("Skipping merge gate - not enabled (global flag or org opt-in off)", {
            extra: { organizationId: meta.organizationId },
        });
        return { status: "skipped" };
    }

    if (!isOnboardingComplete(meta.onboardingStep)) {
        logger.info("Skipping merge gate - application is not fully onboarded");
        return { status: "skipped" };
    }

    const prMeta = await resolvePrMeta({
        branchId: meta.branchId,
        githubRepositoryId: meta.githubRepositoryId,
        githubClient: github.githubClient,
    });
    if (prMeta.prNumber <= 0) {
        logger.info("Skipping merge gate - snapshot is not attached to a PR");
        return { status: "skipped" };
    }

    const report = await loadReport(db, meta);
    const result = buildMergeGateCheckResult({
        verdict: report?.verdict ?? "passed",
        // No persisted report means the pipeline never reached a verdict - fail open to neutral.
        errored: outcome.kind === "failed" || report == null,
        coverageGapCount: report?.coverageGapCount ?? 0,
        investigatedCount: report?.investigatedCount ?? 0,
        clientBugHeadlines: report?.clientBugHeadlines ?? [],
    });

    const store = createGitHubCheckRunStore(db);
    // Serialize against a concurrent PR-open `postPending` for the same head, so the update/create
    // choice is made under the lock and we never post a second `Autonoma` check run for the commit.
    await store.runExclusive(github.repoFullName, meta.headSha, async () => {
        const existing = await store.getByHead(github.repoFullName, meta.headSha);
        if (existing != null) {
            await github.githubClient.updateCheckRun({
                repoFullName: github.repoFullName,
                checkRunId: existing.checkRunId,
                status: "completed",
                conclusion: result.conclusion,
                title: result.title,
                summary: result.summary,
            });
            await store.setConclusion(github.repoFullName, meta.headSha, result.conclusion);
            return;
        }
        // No pending check was posted at PR open (e.g. the org was enabled after the PR opened) - create one now.
        const checkRunId = await github.githubClient.createCheckRun({
            repoFullName: github.repoFullName,
            headSha: meta.headSha,
            name: MERGE_GATE_CHECK_NAME,
            status: "completed",
            conclusion: result.conclusion,
            title: result.title,
            summary: result.summary,
        });
        await store.upsert({
            repoFullName: github.repoFullName,
            prNumber: prMeta.prNumber,
            headSha: meta.headSha,
            checkRunId,
            conclusion: result.conclusion,
        });
    });

    analytics.capture(
        meta.organizationId,
        MERGE_GATE_EVENT.checkPosted,
        {
            organizationId: meta.organizationId,
            repoFullName: github.repoFullName,
            prNumber: prMeta.prNumber,
            headSha: meta.headSha,
            conclusion: result.conclusion,
            snapshotId: meta.snapshotId,
            openBugCount: report?.clientBugHeadlines.length ?? 0,
        },
        { [MERGE_GATE_ANALYTICS_GROUP]: meta.organizationId },
    );

    logger.info("Applied merge-gate verdict", {
        extra: { conclusion: result.conclusion, prNumber: prMeta.prNumber },
    });
    return { status: "posted", conclusion: result.conclusion };
}

interface LoadedReport {
    verdict: "client_bug" | "passed";
    coverageGapCount: number;
    investigatedCount: number;
    clientBugHeadlines: string[];
}

/**
 * Read the persisted run's verdict, its coverage-gap count, and the `client_bug` headlines (for the failure summary).
 */
async function loadReport(db: PrismaClient, meta: SnapshotMeta): Promise<LoadedReport | undefined> {
    // Both key only on the snapshot and neither consumes the other, so they run concurrently; the findings are
    // discarded when there is no report. The headlines are the CURRENT classifications': a self-heal iteration this
    // run superseded is history, never a bug it reports.
    const [report, clientBugs] = await Promise.all([
        db.analysisReport.findUnique({
            where: { snapshotId: meta.snapshotId },
            select: { verdict: true, testCount: true, coverage: true },
        }),
        db.analysisFinding.findMany({
            where: { reportSnapshotId: meta.snapshotId, currentClassification: { category: CLIENT_BUG } },
            select: { currentClassification: { select: { headline: true } } },
        }),
    ]);
    if (report == null) return undefined;

    const coverage = coverageSummarySchema.safeParse(report.coverage);
    return {
        verdict: report.verdict === CLIENT_BUG ? CLIENT_BUG : ANALYSIS_VERDICT.passed,
        coverageGapCount: coverage.success ? coverage.data.total : 0,
        investigatedCount: report.testCount,
        clientBugHeadlines: clientBugs.flatMap((finding) =>
            finding.currentClassification != null ? [finding.currentClassification.headline] : [],
        ),
    };
}
