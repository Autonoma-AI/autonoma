import { analytics } from "@autonoma/analytics";
import { db } from "@autonoma/db";
import {
    buildMergeGateCheckResult,
    createGitHubCheckRunStore,
    MERGE_GATE_ANALYTICS_GROUP,
    MERGE_GATE_CHECK_NAME,
    MERGE_GATE_EVENT,
} from "@autonoma/github/check";
import { isOnboardingComplete } from "@autonoma/github/comment";
import { logger as rootLogger } from "@autonoma/logger";
import { ANALYSIS_VERDICT, coverageSummarySchema } from "@autonoma/types";
import type { ApplyMergeGateVerdictInput, ApplyMergeGateVerdictOutput } from "@autonoma/workflow/activities";
import { resolvePrMeta } from "../../codebase/pr-meta";
import { resolveSnapshotMeta } from "../../codebase/snapshot-context";
import { env } from "../../env";

/** The verdict string the app-health plane files a real client bug under. Anything else is the `passed` plane. */
const CLIENT_BUG = ANALYSIS_VERDICT.client_bug;

/**
 * Merge-gate finalize step: read the persisted `AnalysisReport.verdict` for the run's snapshot, map it to the
 * `Autonoma` check-run conclusion, and post/update the check.
 * Gated OFF by default: the global `MERGE_GATE_ENABLED` switch AND the org's `mergeGateEnabled` (which itself requires `analysisEnabled`).
 */
export async function applyMergeGateVerdict(input: ApplyMergeGateVerdictInput): Promise<ApplyMergeGateVerdictOutput> {
    const { snapshotId } = input;
    const logger = rootLogger.child({ name: "applyMergeGateVerdict" });
    logger.info("Applying merge-gate verdict");

    if (!env.MERGE_GATE_ENABLED) {
        logger.info("Skipping merge gate - MERGE_GATE_ENABLED is off");
        return { status: "skipped" };
    }

    const meta = await resolveSnapshotMeta(snapshotId);

    const settings = await db.organizationSettings.findUnique({
        where: { organizationId: meta.organizationId },
        select: { mergeGateEnabled: true, analysisEnabled: true },
    });
    const gateEnabledForOrg = settings?.mergeGateEnabled === true && settings.analysisEnabled === true;
    if (!gateEnabledForOrg) {
        logger.info("Skipping merge gate - not enabled for this org", {
            extra: { organizationId: meta.organizationId },
        });
        return { status: "skipped" };
    }

    if (!isOnboardingComplete(meta.onboardingStep)) {
        logger.info("Skipping merge gate - application is not fully onboarded");
        return { status: "skipped" };
    }

    const prMeta = await resolvePrMeta(meta);
    if (prMeta.prNumber <= 0) {
        logger.info("Skipping merge gate - snapshot is not attached to a PR");
        return { status: "skipped" };
    }

    const report = await loadReport(snapshotId);
    const result = buildMergeGateCheckResult({
        verdict: report?.verdict ?? "passed",
        // No persisted report means the pipeline never reached a verdict - fail open to neutral.
        errored: report == null,
        coverageGapCount: report?.coverageGapCount ?? 0,
        clientBugHeadlines: report?.clientBugHeadlines ?? [],
    });

    const store = createGitHubCheckRunStore(db);
    // Serialize against a concurrent PR-open `postPending` for the same head, so the update/create
    // choice is made under the lock and we never post a second `Autonoma` check run for the commit.
    await store.runExclusive(meta.repoFullName, meta.headSha, async () => {
        const existing = await store.getByHead(meta.repoFullName, meta.headSha);
        if (existing != null) {
            await meta.githubClient.updateCheckRun({
                repoFullName: meta.repoFullName,
                checkRunId: existing.checkRunId,
                status: "completed",
                conclusion: result.conclusion,
                title: result.title,
                summary: result.summary,
                actions: result.actions,
            });
            await store.setConclusion(meta.repoFullName, meta.headSha, result.conclusion);
            return;
        }
        // No pending check was posted at PR open (e.g. the org was enabled after the PR opened) - create one now.
        const checkRunId = await meta.githubClient.createCheckRun({
            repoFullName: meta.repoFullName,
            headSha: meta.headSha,
            name: MERGE_GATE_CHECK_NAME,
            status: "completed",
            conclusion: result.conclusion,
            title: result.title,
            summary: result.summary,
            actions: result.actions,
        });
        await store.upsert({
            repoFullName: meta.repoFullName,
            prNumber: prMeta.prNumber,
            headSha: meta.headSha,
            checkRunId,
            conclusion: result.conclusion,
        });
    });

    analytics.capture(
        meta.organizationId,
        MERGE_GATE_EVENT.checkPosted,
        { conclusion: result.conclusion, prNumber: prMeta.prNumber, repoFullName: meta.repoFullName },
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
    clientBugHeadlines: string[];
}

/**
 * Read the persisted run's verdict, its coverage-gap count, and the `client_bug` headlines (for the failure summary).
 */
async function loadReport(snapshotId: string): Promise<LoadedReport | undefined> {
    const report = await db.analysisReport.findUnique({
        where: { snapshotId },
        select: {
            verdict: true,
            coverage: true,
            findings: {
                where: { category: CLIENT_BUG },
                orderBy: { displayOrder: "asc" },
                select: { headline: true },
            },
        },
    });
    if (report == null) return undefined;

    const coverage = coverageSummarySchema.safeParse(report.coverage);
    return {
        verdict: report.verdict === CLIENT_BUG ? CLIENT_BUG : ANALYSIS_VERDICT.passed,
        coverageGapCount: coverage.success ? coverage.data.total : 0,
        clientBugHeadlines: report.findings.map((finding) => finding.headline),
    };
}
