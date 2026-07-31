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

/** The single GitHub read merge detection needs, so callers (and tests) need not hold a full client. */
export type AssociatedPullRequestsReader = Pick<GitHubInstallationClient, "getAssociatedPullRequests">;

export interface DetectMergesParams {
    /**
     * Commit SHAs in the range `baseSha..headSha`, ordered newest-first (the
     * default of `git log baseSha..headSha`). Callers typically obtain this
     * via `listCommitsInRange`.
     */
    commits: string[];
    githubClient: AssociatedPullRequestsReader;
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

/**
 * Whether git can prove `baseSha` is an ancestor of `headSha` in this clone.
 *
 * The exact detector for a truncated {@link listCommitsInRange}: the clone is shallow with the base fetched as a
 * separate graft, so once the base falls outside the graft `git log base..head` silently under-reports (returns
 * some commits, not all) and merges in the missing span go undetected. Whenever that happens git also cannot
 * connect the two commits, so a false answer here means the range is incomplete. Any git failure (a bad object,
 * a missing SHA) answers false - the caller is deciding whether to trust the range, and an unverifiable range is
 * exactly as untrustworthy as a disproven one.
 */
export async function isBaseAncestorOfHead(repoDir: string, baseSha: string, headSha: string): Promise<boolean> {
    const logger = rootLogger.child({ name: "isBaseAncestorOfHead" });
    try {
        await execFileAsync("git", ["merge-base", "--is-ancestor", baseSha, headSha], { cwd: repoDir });
        return true;
    } catch (err) {
        logger.debug("Base is not a provable ancestor of head in this clone", {
            extra: { repoDir, baseSha, headSha, err },
        });
        return false;
    }
}
