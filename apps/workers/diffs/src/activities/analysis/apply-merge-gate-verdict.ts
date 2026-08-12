import { analytics } from "@autonoma/analytics";
import type { PrismaClient } from "@autonoma/db";
import {
    buildMergeGateCheckResult,
    createGitHubCheckRunStore,
    MERGE_GATE_ANALYTICS_GROUP,
    MERGE_GATE_CHECK_NAME,
    MERGE_GATE_EVENT,
} from "@autonoma/github/check";
import { hasGoneLive } from "@autonoma/github/comment";
import { logger as rootLogger } from "@autonoma/logger";
import {
    ANALYSIS_VERDICT,
    type AnalysisIssueSeverity,
    type AnalysisRunOutcome,
    analysisIssueSeveritySchema,
    analysisIssueStatusSchema,
    compareAnalysisIssues,
    coverageSummarySchema,
} from "@autonoma/types";
import { resolveRunTarget } from "../../codebase/run-target";
import type { GitHubAccess, SnapshotMeta } from "../../codebase/snapshot-context";
import { isMergeGateEnabledForOrg } from "./merge-gate-enabled";

/** The verdict string the app-health plane files a real client bug under. Anything else is the `passed` plane. */
const CLIENT_BUG = ANALYSIS_VERDICT.client_bug;

/** The issue kind that blocks the merge; environment/scenario issues never do. */
const BUG_KIND = "bug";

/** Where a bug whose stored severity does not parse sorts - listed, but last. */
const UNPARSED_SEVERITY: AnalysisIssueSeverity = analysisIssueSeveritySchema.enum.low;

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

    if (!hasGoneLive(meta.onboardingStep)) {
        logger.info("Skipping merge gate - application is not fully onboarded");
        return { status: "skipped" };
    }

    const target = await resolveRunTarget({
        branchId: meta.branchId,
        githubRepositoryId: meta.githubRepositoryId,
        githubClient: github.githubClient,
    });
    if (target.kind !== "pull_request") {
        logger.info("Skipping merge gate - a main-branch run has no merge to gate", {
            extra: { branchName: target.branchName },
        });
        return { status: "skipped" };
    }

    const report = await loadReport(db, meta);
    const result = buildMergeGateCheckResult({
        verdict: report?.verdict ?? "passed",
        // No persisted report means the pipeline never reached a verdict - fail open to neutral.
        errored: outcome.kind === "failed" || report == null,
        coverageGapCount: report?.coverageGapCount ?? 0,
        investigatedCount: report?.investigatedCount ?? 0,
        clientBugTitles: report?.clientBugTitles ?? [],
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
            prNumber: target.prNumber,
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
            prNumber: target.prNumber,
            headSha: meta.headSha,
            conclusion: result.conclusion,
            snapshotId: meta.snapshotId,
            openBugCount: report?.clientBugTitles.length ?? 0,
        },
        { [MERGE_GATE_ANALYTICS_GROUP]: meta.organizationId },
    );

    logger.info("Applied merge-gate verdict", {
        extra: { conclusion: result.conclusion, prNumber: target.prNumber },
    });
    return { status: "posted", conclusion: result.conclusion };
}

interface LoadedReport {
    verdict: "client_bug" | "passed";
    coverageGapCount: number;
    investigatedCount: number;
    clientBugTitles: string[];
}

/**
 * Read the persisted run's verdict and coverage-gap count, plus the branch's open bug titles for the failure summary.
 */
async function loadReport(db: PrismaClient, meta: SnapshotMeta): Promise<LoadedReport | undefined> {
    // The check names the branch's OPEN bug issues - the same rows the verdict counts and the PR comment cards. Read
    // per-snapshot findings instead and a bug carried from an earlier commit, which no test re-ran here, is missing
    // from a check that blocks because of it. Both reads key only on ids they already have, so they run concurrently;
    // the issues are discarded when there is no report.
    const [report, openBugs] = await Promise.all([
        db.analysisReport.findUnique({
            where: { snapshotId: meta.snapshotId },
            select: { verdict: true, testCount: true, coverage: true },
        }),
        db.analysisIssue.findMany({
            where: { branchId: meta.branchId, status: analysisIssueStatusSchema.enum.open, kind: BUG_KIND },
            select: { title: true, severity: true },
        }),
    ]);
    if (report == null) return undefined;

    const coverage = coverageSummarySchema.safeParse(report.coverage);
    return {
        verdict: report.verdict === CLIENT_BUG ? CLIENT_BUG : ANALYSIS_VERDICT.passed,
        coverageGapCount: coverage.success ? coverage.data.total : 0,
        investigatedCount: report.testCount,
        clientBugTitles: toBugTitles(openBugs),
    };
}

/**
 * The open bugs' titles, most severe first, ordered by the shared comparator so the check lists them in the same
 * order the PR comment cards them. A row whose stored severity does not parse is still listed - a blocking check must
 * never silently omit a bug - it just sorts last.
 */
function toBugTitles(issues: { title: string; severity: string }[]): string[] {
    return issues
        .map((issue) => {
            const severity = analysisIssueSeveritySchema.safeParse(issue.severity);
            return { title: issue.title, severity: severity.success ? severity.data : UNPARSED_SEVERITY };
        })
        .sort((a, b) =>
            compareAnalysisIssues({ kind: BUG_KIND, severity: a.severity }, { kind: BUG_KIND, severity: b.severity }),
        )
        .map((issue) => issue.title);
}
