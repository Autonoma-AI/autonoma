import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitHubInstallationClient, PullRequest } from "@autonoma/github";
import { logger as rootLogger } from "@autonoma/logger";

const execFileAsync = promisify(execFile);

/**
 * One merge that the diff workflow must account for when producing the new
 * target snapshot. Phase 1 only emits entries in the `feat/x -> main`
 * direction: the merge's PR has `baseRef` matching the branch currently
 * being processed.
 *
 * `sourceHeadSha` is the SHA used to pin the source snapshot. We use the PR's
 * `headSha` rather than the second parent of the merge commit because it
 * works uniformly across the three merge strategies (merge, squash, rebase).
 */
export interface RelevantMerge {
    prNumber: number;
    sourceHeadRef: string;
    sourceHeadSha: string;
    mergeCommitSha: string;
    mergedAt?: string;
}

export interface DetectMergesParams {
    /**
     * Commit SHAs in the range `baseSha..headSha`, ordered newest-first (the
     * default of `git log baseSha..headSha`). Callers typically obtain this
     * via `listCommitsInRange`.
     */
    commits: string[];
    githubClient: GitHubInstallationClient;
    owner: string;
    repo: string;
    /**
     * Short branch name of the branch currently being processed (e.g. "main"),
     * sourced from GitHub (typically the repository's `defaultBranch`). Must
     * be the short name, not a fully-qualified ref like "refs/heads/main" -
     * GitHub's PR `baseRef` is always the short name, and a fully-qualified
     * value would never match. Do NOT pass `branch.githubRef` from the DB;
     * that column is being deprecated.
     */
    targetBranchRef: string;
}

/**
 * For each commit in the range, query GitHub for associated PRs and keep the
 * ones that are merged and target the current branch. Returns one
 * `RelevantMerge` per distinct PR number.
 *
 * Phase 1 (Option A): detects only PR-based merges. Local `git merge`
 * followed by a push does not produce a PR and is intentionally not detected;
 * those commits fall through to the normal `code_change` path.
 */
export async function detectRelevantMerges(params: DetectMergesParams): Promise<RelevantMerge[]> {
    const logger = rootLogger.child({ name: "detectRelevantMerges" });
    const { commits, githubClient, owner, repo, targetBranchRef } = params;
    const normalizedTargetRef = targetBranchRef.replace(/^refs\/heads\//, "");

    logger.info("Detecting relevant merges in range", {
        commitCount: commits.length,
        targetBranchRef: normalizedTargetRef,
    });

    const cache = new Map<string, PullRequest[]>();
    const byPrNumber = new Map<number, RelevantMerge>();

    for (const sha of commits) {
        let associated = cache.get(sha);
        if (associated == null) {
            associated = await githubClient.getAssociatedPullRequests(owner, repo, sha);
            cache.set(sha, associated);
        }

        for (const pr of associated) {
            if (!pr.merged) continue;
            if (pr.baseRef !== normalizedTargetRef) continue;
            if (byPrNumber.has(pr.number)) continue;

            byPrNumber.set(pr.number, {
                prNumber: pr.number,
                sourceHeadRef: pr.headRef,
                sourceHeadSha: pr.headSha,
                mergeCommitSha: pr.mergeCommitSha ?? sha,
                mergedAt: pr.mergedAt,
            });
        }
    }

    const result = [...byPrNumber.values()];
    logger.info("Identified relevant merges", {
        count: result.length,
        prNumbers: result.map((m) => m.prNumber),
    });
    return result;
}

export async function listCommitsInRange(repoDir: string, baseSha: string, headSha: string): Promise<string[]> {
    const { stdout } = await execFileAsync("git", ["log", `${baseSha}..${headSha}`, "--format=%H"], {
        cwd: repoDir,
        maxBuffer: 10 * 1024 * 1024,
    });
    return stdout
        .trim()
        .split("\n")
        .filter((line) => line.length > 0);
}
