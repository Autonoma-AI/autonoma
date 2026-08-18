import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import type { PostAnalyzingPrCommentInput, PostAnalyzingPrCommentOutput } from "@autonoma/workflow/activities";
import { loadSnapshotMeta, resolveGitHubAccess } from "../../codebase/snapshot-context";
import { postAnalyzingPrComment } from "./post-pr-comment";

/**
 * The workflow-facing activity for the in-flight PR comment. Best-effort by contract: it resolves the snapshot's
 * GitHub access itself and swallows every failure, so a comment problem can never fail the analysis run it is only
 * narrating. The settled comment is posted separately, by `settleAnalysisRun`.
 */
export async function postAnalyzingPrCommentActivity(
    input: PostAnalyzingPrCommentInput,
): Promise<PostAnalyzingPrCommentOutput> {
    const logger = rootLogger.child({ name: "postAnalyzingPrCommentActivity", snapshotId: input.snapshotId });
    try {
        const meta = await loadSnapshotMeta(input.snapshotId);
        const github = await resolveGitHubAccess(meta);
        const result = await postAnalyzingPrComment({ db, github, meta, firstPost: input.firstPost });
        return { status: result.status };
    } catch (err) {
        logger.warn("Failed to post the in-flight PR comment; continuing", { extra: { err } });
        return { status: "skipped" };
    }
}
