import { analytics } from "@autonoma/analytics";
import type { PrismaClient } from "@autonoma/db";
import {
    buildMergeGateCheckResult,
    createGitHubCheckRunStore,
    type MergeGateCheckResult,
    MERGE_GATE_ANALYTICS_GROUP,
    MERGE_GATE_CHECK_NAME,
    MERGE_GATE_EVENT,
} from "@autonoma/github/check";
import { hasGoneLive } from "@autonoma/github/comment";
import { logger as rootLogger } from "@autonoma/logger";
import { type AnalysisRunOutcome, type AnalysisVerdictSummary } from "@autonoma/types";
import { resolveRunTarget } from "../../codebase/run-target";
import type { GitHubAccess, SnapshotMeta } from "../../codebase/snapshot-context";
import { getAnalysisStore } from "../../services";
import { isMergeGateEnabledForOrg } from "./merge-gate-enabled";

/** What an errored run gates on: nothing. `errored` is what actually decides the conclusion. */
const NO_VERDICT: AnalysisVerdictSummary = {
    state: "no_tests_needed",
    bugCount: 0,
    coverageGapCount: 0,
    investigatedCount: 0,
};

/**
 * Merge-gate finalize step: resolve the PR's verdict, map it to the `Autonoma` check-run conclusion, and
 * post/update the check.
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

    const { result, bugTitles } = await resolveMergeGateCheckResult(meta, outcome);

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
            openBugCount: bugTitles.length,
        },
        { [MERGE_GATE_ANALYTICS_GROUP]: meta.organizationId },
    );

    logger.info("Applied merge-gate verdict", {
        extra: { conclusion: result.conclusion, prNumber: target.prNumber },
    });
    return { status: "posted", conclusion: result.conclusion };
}

/** What conclusion the PR's verdict earns and which bugs the summary names, separated from posting it. */
export async function resolveMergeGateCheckResult(
    meta: SnapshotMeta,
    outcome: AnalysisRunOutcome,
): Promise<{ result: MergeGateCheckResult; bugTitles: string[] }> {
    const gate = await loadGateInput(meta);
    const result = buildMergeGateCheckResult({
        // No persisted report means the pipeline never reached a verdict - fail open to neutral.
        errored: outcome.kind === "failed" || gate == null,
        verdict: gate?.verdict ?? NO_VERDICT,
        clientBugTitles: gate?.clientBugTitles ?? [],
    });
    return { result, bugTitles: gate?.clientBugTitles ?? [] };
}

interface MergeGateInput {
    verdict: AnalysisVerdictSummary;
    clientBugTitles: string[];
}

/**
 * The PR's verdict and the bug titles the failure summary names. Both come from the branch's ledger, not this
 * run's findings: a bug carried from an earlier commit, which no test re-ran here, would otherwise be missing
 * from a check that blocks because of it. The report is read only to tell "settled" from "never got there".
 */
async function loadGateInput(meta: SnapshotMeta): Promise<MergeGateInput | undefined> {
    const store = getAnalysisStore();
    const [settled, { verdict, openBugs }] = await Promise.all([
        store.forAnalysis(meta.snapshotId).isSettled(),
        store.forBranch(meta.branchId).verdictWithOpenBugs(),
    ]);
    // No settled report means the pipeline never reached a verdict on this run - the caller fails open to neutral.
    if (!settled) return undefined;

    // Already in the ledger's canonical order, which is the order the PR comment cards them in.
    return { verdict, clientBugTitles: openBugs.map((issue) => issue.title) };
}
