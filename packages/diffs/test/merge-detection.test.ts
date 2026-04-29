import type { GitHubInstallationClient, PullRequest } from "@autonoma/github";
import { describe, expect, it, vi } from "vitest";
import { detectRelevantMerges } from "../src/merge-detection";

function buildPr(overrides: Partial<PullRequest>): PullRequest {
    const defaults: PullRequest = {
        number: 1,
        title: "PR",
        headRef: "feat/x",
        headSha: "feat-head-sha",
        baseRef: "main",
        baseSha: "base",
        url: "https://example.test",
        authorLogin: "user",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        merged: true,
        mergedAt: "2026-01-02T00:00:00Z",
        mergeMethod: "merge",
        mergeCommitSha: "merge-commit-sha",
    };
    return { ...defaults, ...overrides };
}

function makeStubClient(map: Record<string, PullRequest[]>): {
    client: GitHubInstallationClient;
    calls: string[];
} {
    const calls: string[] = [];
    const client = {
        async getAssociatedPullRequests(_owner: string, _repo: string, sha: string) {
            calls.push(sha);
            return map[sha] ?? [];
        },
    } as unknown as GitHubInstallationClient;
    return { client, calls };
}

describe("detectRelevantMerges", () => {
    it("finds a single feat/x -> main merge", async () => {
        const pr = buildPr({ number: 42, headSha: "feat-sha", mergeCommitSha: "mc" });
        const { client } = makeStubClient({ mc: [pr] });
        const result = await detectRelevantMerges({
            commits: ["mc"],
            githubClient: client,
            owner: "org",
            repo: "repo",
            targetBranchRef: "main",
        });
        expect(result).toEqual([
            {
                prNumber: 42,
                sourceHeadRef: "feat/x",
                sourceHeadSha: "feat-sha",
                mergeCommitSha: "mc",
                mergedAt: pr.mergedAt,
            },
        ]);
    });

    it("ignores PRs whose baseRef does not match the target branch", async () => {
        const pr = buildPr({ number: 42, baseRef: "not-main" });
        const { client } = makeStubClient({ c1: [pr] });
        const result = await detectRelevantMerges({
            commits: ["c1"],
            githubClient: client,
            owner: "o",
            repo: "r",
            targetBranchRef: "main",
        });
        expect(result).toEqual([]);
    });

    it("ignores unmerged PRs", async () => {
        const pr = buildPr({ number: 42, merged: false });
        const { client } = makeStubClient({ c1: [pr] });
        const result = await detectRelevantMerges({
            commits: ["c1"],
            githubClient: client,
            owner: "o",
            repo: "r",
            targetBranchRef: "main",
        });
        expect(result).toEqual([]);
    });

    it("dedupes by prNumber across multiple commits (rebase merge spreads commits)", async () => {
        const pr = buildPr({ number: 7, mergeCommitSha: undefined, headSha: "feat-tip" });
        const { client, calls } = makeStubClient({ c1: [pr], c2: [pr], c3: [pr] });
        const result = await detectRelevantMerges({
            commits: ["c1", "c2", "c3"],
            githubClient: client,
            owner: "o",
            repo: "r",
            targetBranchRef: "main",
        });
        expect(result).toHaveLength(1);
        expect(result[0]!.prNumber).toBe(7);
        expect(result[0]!.mergeCommitSha).toBe("c1");
        expect(calls).toEqual(["c1", "c2", "c3"]);
    });

    it("detects multiple distinct merges (accumulated)", async () => {
        const a = buildPr({ number: 1, headSha: "fa", mergeCommitSha: "ma" });
        const b = buildPr({ number: 2, headSha: "fb", mergeCommitSha: "mb", headRef: "feat/y" });
        const { client } = makeStubClient({ ma: [a], mb: [b] });
        const result = await detectRelevantMerges({
            commits: ["ma", "mb"],
            githubClient: client,
            owner: "o",
            repo: "r",
            targetBranchRef: "main",
        });
        expect(result.map((r) => r.prNumber).sort()).toEqual([1, 2]);
    });

    it("caches repeat SHA lookups", async () => {
        const pr = buildPr({ number: 99, mergeCommitSha: "x" });
        const { client, calls } = makeStubClient({ x: [pr] });
        const result = await detectRelevantMerges({
            commits: ["x", "x", "x"],
            githubClient: client,
            owner: "o",
            repo: "r",
            targetBranchRef: "main",
        });
        expect(result).toHaveLength(1);
        expect(calls).toEqual(["x"]);
    });

    it("falls back to the commit SHA when PR has no mergeCommitSha", async () => {
        const pr = buildPr({ number: 7, mergeCommitSha: undefined });
        const { client } = makeStubClient({ c1: [pr] });
        const result = await detectRelevantMerges({
            commits: ["c1"],
            githubClient: client,
            owner: "o",
            repo: "r",
            targetBranchRef: "main",
        });
        expect(result[0]!.mergeCommitSha).toBe("c1");
    });

    it("mixes relevant and irrelevant PRs on the same commit", async () => {
        const relevant = buildPr({ number: 1 });
        const irrelevant = buildPr({ number: 2, baseRef: "release" });
        const { client } = makeStubClient({ c1: [relevant, irrelevant] });
        const result = await detectRelevantMerges({
            commits: ["c1"],
            githubClient: client,
            owner: "o",
            repo: "r",
            targetBranchRef: "main",
        });
        expect(result).toHaveLength(1);
        expect(result[0]!.prNumber).toBe(1);
    });

    it("does not call the client if the range is empty", async () => {
        const spy = vi.fn();
        const client = {
            getAssociatedPullRequests: spy,
        } as unknown as GitHubInstallationClient;
        const result = await detectRelevantMerges({
            commits: [],
            githubClient: client,
            owner: "o",
            repo: "r",
            targetBranchRef: "main",
        });
        expect(result).toEqual([]);
        expect(spy).not.toHaveBeenCalled();
    });
});
