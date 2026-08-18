import { analytics } from "@autonoma/analytics";
import { db } from "@autonoma/db";
import {
    ANALYSIS_RUN_SOURCE,
    createGitHubCheckRunStore,
    MERGE_GATE_ANALYTICS_GROUP,
    MERGE_GATE_CHECK_NAME,
    MERGE_GATE_EVENT,
    MERGE_GATE_IN_PROGRESS_CONCLUSION,
    MERGE_GATE_IN_PROGRESS_SUMMARY,
    MERGE_GATE_IN_PROGRESS_TITLE,
} from "@autonoma/github/check";
import { hasGoneLive } from "@autonoma/github/comment";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import type { OpenMergeGateInput, OpenMergeGateOutput } from "@autonoma/workflow/activities";
import { resolveRunTarget } from "../../codebase/run-target";
import {
    resolveGitHubAccess,
    loadSnapshotMeta,
    type GitHubAccess,
    type SnapshotMeta,
} from "../../codebase/snapshot-context";
import { isMergeGateEnabledForOrg } from "./merge-gate-enabled";

/**
 * The un-requested state a migrated org's `Autonoma` check sits in until something asks for a run. The
 * auto-run-on-ready trigger reaches the analysis pipeline WITHOUT going through `requestAnalysisRun` (it rides the
 * automatic preview-ready path), so this step is what flips that neutral check to the same in-progress "Analyzing"
 * state the on-demand triggers show, and stamps the `ready_for_review` activation.
 */
const UNREQUESTED_CONCLUSION = "neutral";

/**
 * Stage 0 of the analysis pipeline, run for EVERY analysis run. It must never throw.
 */
export async function openMergeGate({ snapshotId }: OpenMergeGateInput): Promise<OpenMergeGateOutput> {
    const logger = rootLogger.child({ name: "openMergeGate", snapshotId });
    try {
        return await tryOpenMergeGate(snapshotId, logger);
    } catch (error) {
        logger.warn("openMergeGate failed; leaving the check as-is and proceeding with the run", {
            extra: { err: error },
        });
        return { status: "skipped" };
    }
}

async function tryOpenMergeGate(snapshotId: string, logger: Logger): Promise<OpenMergeGateOutput> {
    const meta = await loadSnapshotMeta(snapshotId);

    if (!(await isMergeGateEnabledForOrg(meta.organizationId))) return { status: "skipped" };
    if (!hasGoneLive(meta.onboardingStep)) return { status: "skipped" };

    // Only the auto-run-on-ready path flips here. On-demand triggers (comment/label/mcp) already flipped the check
    // and stamped their own source via `requestAnalysisRun`, and a non-migrated org's check is already in-progress
    // from `postPending` - both leave the check non-neutral, so the state guard below skips them too.
    if (!(await isAutoRunOnReadyRun(meta))) return { status: "skipped" };

    const github = await resolveGitHubAccess(meta);
    return await flipCheckToAnalyzing(meta, github, logger);
}

async function flipCheckToAnalyzing(
    meta: SnapshotMeta,
    github: GitHubAccess,
    logger: Logger,
): Promise<OpenMergeGateOutput> {
    const target = await resolveRunTarget({
        branchId: meta.branchId,
        githubRepositoryId: meta.githubRepositoryId,
        githubClient: github.githubClient,
    });
    // A main-branch run has no merge to gate, so there is no check to open. It cannot reach here anyway - the gate
    // only opens for an auto-run-on-ready run, which is a PR trigger - but the guard keeps that independent.
    if (target.kind !== "pull_request") return { status: "skipped" };

    const store = createGitHubCheckRunStore(db);
    let opened = false;

    await store.runExclusive(github.repoFullName, meta.headSha, async () => {
        const existing = await store.getByHead(github.repoFullName, meta.headSha);
        if (existing == null) {
            const checkRunId = await github.githubClient.createCheckRun({
                repoFullName: github.repoFullName,
                headSha: meta.headSha,
                name: MERGE_GATE_CHECK_NAME,
                status: "in_progress",
                title: MERGE_GATE_IN_PROGRESS_TITLE,
                summary: MERGE_GATE_IN_PROGRESS_SUMMARY,
            });
            await store.upsert({
                repoFullName: github.repoFullName,
                prNumber: target.prNumber,
                headSha: meta.headSha,
                checkRunId,
                conclusion: MERGE_GATE_IN_PROGRESS_CONCLUSION,
            });
            opened = true;
        } else if (existing.conclusion === UNREQUESTED_CONCLUSION) {
            // The un-requested neutral state: flip it to the in-progress "Analyzing" state.
            await github.githubClient.updateCheckRun({
                repoFullName: github.repoFullName,
                checkRunId: existing.checkRunId,
                status: "in_progress",
                title: MERGE_GATE_IN_PROGRESS_TITLE,
                summary: MERGE_GATE_IN_PROGRESS_SUMMARY,
            });
            await store.upsert({
                repoFullName: github.repoFullName,
                prNumber: target.prNumber,
                headSha: meta.headSha,
                checkRunId: existing.checkRunId,
                conclusion: MERGE_GATE_IN_PROGRESS_CONCLUSION,
            });
            opened = true;
        } else {
            // Already in-progress
            return;
        }
        await store.setActivation(github.repoFullName, meta.headSha, {
            source: ANALYSIS_RUN_SOURCE.ready_for_review,
            activatedAt: new Date(),
        });
    });

    if (!opened) {
        logger.info("Merge-gate check already in-progress or terminal; nothing to open");
        return { status: "skipped" };
    }

    analytics.capture(
        meta.organizationId,
        MERGE_GATE_EVENT.activated,
        {
            organizationId: meta.organizationId,
            repoFullName: github.repoFullName,
            prNumber: target.prNumber,
            headSha: meta.headSha,
            source: ANALYSIS_RUN_SOURCE.ready_for_review,
            snapshotId: meta.snapshotId,
        },
        { [MERGE_GATE_ANALYTICS_GROUP]: meta.organizationId },
    );

    logger.info("Opened merge-gate check to Analyzing for the auto-run-on-ready run", {
        extra: { prNumber: target.prNumber, headSha: meta.headSha },
    });
    return { status: "opened" };
}

/** Whether this run is a migrated-org auto-run-on-ready run - the only automatic run that should open the gate. */
async function isAutoRunOnReadyRun(meta: SnapshotMeta): Promise<boolean> {
    const [settings, branch] = await Promise.all([
        db.organizationSettings.findUnique({
            where: { organizationId: meta.organizationId },
            select: { activationEnabled: true },
        }),
        db.branch.findUnique({
            where: { id: meta.branchId },
            select: { application: { select: { triggerConfig: { select: { autoRunOnReadyForReview: true } } } } },
        }),
    ]);
    return settings?.activationEnabled === true && branch?.application.triggerConfig?.autoRunOnReadyForReview === true;
}
