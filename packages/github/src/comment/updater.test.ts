import { describe, expect, it } from "vitest";
import { payloadBuilder } from "./payload";
import type { GitHubCommentClient, GitHubCommentStore } from "./types";
import { postOrUpdateCommentOnGithub } from "./updater";

function makeStore(state: { commentId: string | null; headSha: string | null } | null): GitHubCommentStore {
    return {
        async getState() {
            return state;
        },
        async setCommentId(_repoFullName, _prNumber, commentId) {
            if (state != null) state.commentId = commentId;
        },
    };
}

describe("postOrUpdate", () => {
    it("refuses to overwrite a newer commit comment with an older strict update", async () => {
        const calls: string[] = [];
        const client: GitHubCommentClient = {
            async postComment() {
                calls.push("post");
                return "new";
            },
            async updateComment() {
                calls.push("update");
            },
        };

        const result = await postOrUpdateCommentOnGithub({
            client,
            store: makeStore({ commentId: "123", headSha: "newer-sha" }),
            repoFullName: "autonoma/app",
            prNumber: 7,
            lastCommitSha: "older-sha",
            payload: payloadBuilder({ state: "healthy", prNumber: 7 }),
        });

        expect(result.status).toBe("stale_skipped");
        expect(calls).toEqual([]);
    });

    it("updates the existing comment for the active commit", async () => {
        const calls: string[] = [];
        const client: GitHubCommentClient = {
            async postComment() {
                calls.push("post");
                return "new";
            },
            async updateComment(_repoFullName, commentId) {
                calls.push(`update:${commentId}`);
            },
        };

        const result = await postOrUpdateCommentOnGithub({
            client,
            store: makeStore({ commentId: "123", headSha: "same-sha" }),
            repoFullName: "autonoma/app",
            prNumber: 7,
            lastCommitSha: "same-sha",
            payload: payloadBuilder({ state: "running", prNumber: 7 }),
        });

        expect(result.status).toBe("updated");
        expect(calls).toEqual(["update:123"]);
    });

    it("allows a new-head pending update before the environment row is rewritten", async () => {
        const calls: string[] = [];
        const client: GitHubCommentClient = {
            async postComment() {
                calls.push("post");
                return "new";
            },
            async updateComment(_repoFullName, commentId) {
                calls.push(`update:${commentId}`);
            },
        };

        const result = await postOrUpdateCommentOnGithub({
            client,
            store: makeStore({ commentId: "123", headSha: "previous-sha" }),
            repoFullName: "autonoma/app",
            prNumber: 7,
            lastCommitSha: "new-sha",
            staleGuard: "allow-new-head",
            payload: payloadBuilder({ state: "running", prNumber: 7 }),
        });

        expect(result.status).toBe("updated");
        expect(calls).toEqual(["update:123"]);
    });
});
