import { describe, expect, it, vi } from "vitest";
import type { GitHubInstallationClient } from "../src/github-installation-client";
import { OctokitGithubHistory } from "../src/history/octokit-github-history";

function createMockClient(): GitHubInstallationClient {
    return {
        listCommits: vi.fn(),
        compareCommits: vi.fn(),
    } as unknown as GitHubInstallationClient;
}

describe("OctokitGithubHistory", () => {
    const owner = "autonoma-ai";
    const repo = "agent";
    const branchRef = "main";

    describe("nextCommitOnBranch", () => {
        it("returns latest SHA when branch has new commits", async () => {
            const client = createMockClient();
            vi.mocked(client.listCommits).mockResolvedValue([{ sha: "new-sha" }]);

            const history = new OctokitGithubHistory(client, owner, repo, branchRef);
            const result = await history.nextCommitOnBranch("old-sha");

            expect(result).toBe("new-sha");
            expect(client.listCommits).toHaveBeenCalledWith(owner, repo, { sha: branchRef, perPage: 1 });
        });

        it("returns undefined when latest commit matches afterSha", async () => {
            const client = createMockClient();
            vi.mocked(client.listCommits).mockResolvedValue([{ sha: "same-sha" }]);

            const history = new OctokitGithubHistory(client, owner, repo, branchRef);
            const result = await history.nextCommitOnBranch("same-sha");

            expect(result).toBeUndefined();
        });

        it("returns undefined when no commits found on branch", async () => {
            const client = createMockClient();
            vi.mocked(client.listCommits).mockResolvedValue([]);

            const history = new OctokitGithubHistory(client, owner, repo, branchRef);
            const result = await history.nextCommitOnBranch("any-sha");

            expect(result).toBeUndefined();
        });
    });

    describe("latestBetween", () => {
        it("returns the same SHA when both are identical", async () => {
            const client = createMockClient();
            const history = new OctokitGithubHistory(client, owner, repo, branchRef);

            const result = await history.latestBetween("abc123", "abc123");

            expect(result).toBe("abc123");
            expect(client.compareCommits).not.toHaveBeenCalled();
        });

        it("returns sha1 when sha1 is ahead of sha2", async () => {
            const client = createMockClient();
            vi.mocked(client.compareCommits).mockResolvedValue({
                aheadBy: 3,
                behindBy: 0,
                status: "ahead",
                files: [],
            });

            const history = new OctokitGithubHistory(client, owner, repo, branchRef);
            const result = await history.latestBetween("newer-sha", "older-sha");

            expect(result).toBe("newer-sha");
            expect(client.compareCommits).toHaveBeenCalledWith(owner, repo, "older-sha", "newer-sha");
        });

        it("returns sha2 when sha1 is not ahead", async () => {
            const client = createMockClient();
            vi.mocked(client.compareCommits).mockResolvedValue({
                aheadBy: 0,
                behindBy: 2,
                status: "behind",
                files: [],
            });

            const history = new OctokitGithubHistory(client, owner, repo, branchRef);
            const result = await history.latestBetween("older-sha", "newer-sha");

            expect(result).toBe("newer-sha");
        });
    });
});
