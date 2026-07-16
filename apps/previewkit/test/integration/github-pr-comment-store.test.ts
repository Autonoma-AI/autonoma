import {
    createGitHubPrCommentStore,
    type GitHubCommentClient,
    payloadBuilder,
    postOrUpdateCommentOnGithub,
} from "@autonoma/github/comment";
import { integrationTestSuite } from "@autonoma/integration-test";
import { expect } from "vitest";
import { PreviewkitTestHarness } from "./harness";

function makeRecordingClient(postedId: string): { client: GitHubCommentClient; calls: string[] } {
    const calls: string[] = [];
    const client: GitHubCommentClient = {
        async postComment() {
            calls.push("post");
            return postedId;
        },
        async updateComment(_repoFullName, commentId) {
            calls.push(`update:${commentId}`);
        },
        async deleteComment(_repoFullName, commentId) {
            calls.push(`delete:${commentId}`);
        },
    };
    return { client, calls };
}

// A recording client that hands out a distinct id per post, so repost flows
// (delete old id, post new id) are observable end to end.
function makeSequentialClient(): { client: GitHubCommentClient; calls: string[] } {
    let posts = 0;
    const calls: string[] = [];
    const client: GitHubCommentClient = {
        async postComment() {
            const id = `comment-${++posts}`;
            calls.push(`post:${id}`);
            return id;
        },
        async updateComment(_repoFullName, commentId) {
            calls.push(`update:${commentId}`);
        },
        async deleteComment(_repoFullName, commentId) {
            calls.push(`delete:${commentId}`);
        },
    };
    return { client, calls };
}

// A client whose postComment is slow and hands out a distinct id each time, so a
// concurrency bug (two callers both posting before either persists) is observable.
function makeSlowUniqueClient(): {
    client: GitHubCommentClient;
    postCount: () => number;
    deleteCount: () => number;
} {
    let posts = 0;
    let deletes = 0;
    const client: GitHubCommentClient = {
        async postComment() {
            const n = ++posts;
            await new Promise((resolve) => setTimeout(resolve, 150));
            return `comment-${n}`;
        },
        async updateComment() {},
        async deleteComment() {
            deletes++;
        },
    };
    return { client, postCount: () => posts, deleteCount: () => deletes };
}

integrationTestSuite({
    name: "github pr comment store",
    createHarness: () => PreviewkitTestHarness.create(),
    cases: (test) => {
        test("first run posts and persists the comment id even with no pre-existing row", async ({ harness }) => {
            const store = createGitHubPrCommentStore(harness.db, "investigation");
            const { client, calls } = makeRecordingClient("comment-1");

            const result = await postOrUpdateCommentOnGithub({
                client,
                store,
                repoFullName: "acme/web",
                prNumber: 42,
                lastCommitSha: "sha-aaa",
                payload: payloadBuilder({ state: "healthy", prNumber: 42 }),
            });

            expect(result.status).toBe("posted");
            expect(calls).toEqual(["post"]);

            const row = await harness.db.gitHubPrComment.findUnique({
                where: {
                    repoFullName_prNumber_kind: { repoFullName: "acme/web", prNumber: 42, kind: "investigation" },
                },
            });
            expect(row).not.toBeNull();
            expect(row!.commentId).toBe("comment-1");
            expect(row!.headSha).toBe("sha-aaa");
        });

        test("a second run reuses the same comment instead of posting a duplicate", async ({ harness }) => {
            const store = createGitHubPrCommentStore(harness.db, "investigation");
            const { client, calls } = makeRecordingClient("comment-1");

            const opts = {
                client,
                store,
                repoFullName: "acme/web",
                prNumber: 42,
                payload: payloadBuilder({ state: "healthy", prNumber: 42 }),
            };

            await postOrUpdateCommentOnGithub({ ...opts, lastCommitSha: "sha-aaa" });
            const second = await postOrUpdateCommentOnGithub({ ...opts, lastCommitSha: "sha-aaa" });

            expect(second.status).toBe("updated");
            expect(calls).toEqual(["post", "update:comment-1"]);

            const rows = await harness.db.gitHubPrComment.findMany({
                where: { repoFullName: "acme/web", prNumber: 42 },
            });
            expect(rows).toHaveLength(1);
            expect(rows[0]!.commentId).toBe("comment-1");
        });

        test("allow-new-head reuses the comment across commits and advances the stored head sha", async ({
            harness,
        }) => {
            const store = createGitHubPrCommentStore(harness.db, "investigation");
            const { client, calls } = makeRecordingClient("comment-1");

            await postOrUpdateCommentOnGithub({
                client,
                store,
                repoFullName: "acme/web",
                prNumber: 42,
                lastCommitSha: "sha-old",
                staleGuard: "allow-new-head",
                payload: payloadBuilder({ state: "running", prNumber: 42 }),
            });

            const result = await postOrUpdateCommentOnGithub({
                client,
                store,
                repoFullName: "acme/web",
                prNumber: 42,
                lastCommitSha: "sha-new",
                staleGuard: "allow-new-head",
                payload: payloadBuilder({ state: "healthy", prNumber: 42 }),
            });

            expect(result.status).toBe("updated");
            expect(calls).toEqual(["post", "update:comment-1"]);

            const row = await harness.db.gitHubPrComment.findUnique({
                where: {
                    repoFullName_prNumber_kind: { repoFullName: "acme/web", prNumber: 42, kind: "investigation" },
                },
            });
            expect(row!.commentId).toBe("comment-1");
            expect(row!.headSha).toBe("sha-new");
        });

        test("preview and investigation keep independent comments for the same PR", async ({ harness }) => {
            const previewStore = createGitHubPrCommentStore(harness.db, "preview");
            const investigationStore = createGitHubPrCommentStore(harness.db, "investigation");
            const preview = makeRecordingClient("preview-comment");
            const investigation = makeRecordingClient("investigation-comment");

            const base = { repoFullName: "acme/web", prNumber: 42, lastCommitSha: "sha-aaa" };

            await postOrUpdateCommentOnGithub({
                ...base,
                client: preview.client,
                store: previewStore,
                payload: payloadBuilder({ state: "running", prNumber: 42 }),
            });
            await postOrUpdateCommentOnGithub({
                ...base,
                client: investigation.client,
                store: investigationStore,
                payload: payloadBuilder({ state: "healthy", prNumber: 42 }),
            });

            // Each flow posts its own comment - neither updates the other.
            expect(preview.calls).toEqual(["post"]);
            expect(investigation.calls).toEqual(["post"]);

            const rows = await harness.db.gitHubPrComment.findMany({
                where: { repoFullName: "acme/web", prNumber: 42 },
                // Postgres orders an enum by its declaration order (preview, investigation), not alphabetically.
                orderBy: { kind: "asc" },
            });
            expect(rows.map((r) => [r.kind, r.commentId])).toEqual([
                ["preview", "preview-comment"],
                ["investigation", "investigation-comment"],
            ]);
        });

        test("two concurrent first completions post only one comment", async ({ harness }) => {
            const store = createGitHubPrCommentStore(harness.db, "investigation");
            const { client, postCount } = makeSlowUniqueClient();

            const fire = () =>
                postOrUpdateCommentOnGithub({
                    client,
                    store,
                    repoFullName: "acme/web",
                    prNumber: 99,
                    lastCommitSha: "sha-aaa",
                    staleGuard: "allow-new-head",
                    payload: payloadBuilder({ state: "healthy", prNumber: 99 }),
                });

            const results = await Promise.all([fire(), fire()]);

            // The advisory lock serializes the two: exactly one posts, the other updates it.
            expect(postCount()).toBe(1);
            expect(results.map((r) => r.status).sort()).toEqual(["posted", "updated"]);

            const rows = await harness.db.gitHubPrComment.findMany({
                where: { repoFullName: "acme/web", prNumber: 99 },
            });
            expect(rows).toHaveLength(1);
            expect(rows[0]!.commentId).toBe("comment-1");
        });

        test("repost deletes the previous comment and posts a fresh one at the bottom", async ({ harness }) => {
            const store = createGitHubPrCommentStore(harness.db, "investigation");
            const { client, calls } = makeSequentialClient();

            const opts = {
                client,
                store,
                repoFullName: "acme/web",
                prNumber: 42,
                staleGuard: "allow-new-head",
                mode: "repost",
                payload: payloadBuilder({ state: "healthy", prNumber: 42 }),
            } as const;

            const first = await postOrUpdateCommentOnGithub({ ...opts, lastCommitSha: "sha-aaa" });
            const second = await postOrUpdateCommentOnGithub({ ...opts, lastCommitSha: "sha-bbb" });

            expect(first.status).toBe("posted");
            expect(second.status).toBe("posted");
            expect(calls).toEqual(["post:comment-1", "delete:comment-1", "post:comment-2"]);

            // Still exactly one row, now pointing at the fresh comment.
            const rows = await harness.db.gitHubPrComment.findMany({
                where: { repoFullName: "acme/web", prNumber: 42 },
            });
            expect(rows).toHaveLength(1);
            expect(rows[0]!.commentId).toBe("comment-2");
            expect(rows[0]!.headSha).toBe("sha-bbb");
        });

        test("two concurrent reposts serialize and leave exactly one comment", async ({ harness }) => {
            const store = createGitHubPrCommentStore(harness.db, "investigation");
            const { client, postCount, deleteCount } = makeSlowUniqueClient();

            const fire = () =>
                postOrUpdateCommentOnGithub({
                    client,
                    store,
                    repoFullName: "acme/web",
                    prNumber: 99,
                    lastCommitSha: "sha-aaa",
                    staleGuard: "allow-new-head",
                    mode: "repost",
                    payload: payloadBuilder({ state: "healthy", prNumber: 99 }),
                });

            const results = await Promise.all([fire(), fire()]);

            // The advisory lock serializes the two: the second deletes the first's
            // fresh comment and posts its own - last writer wins, one comment left.
            expect(results.map((r) => r.status)).toEqual(["posted", "posted"]);
            expect(postCount()).toBe(2);
            expect(deleteCount()).toBe(1);

            const rows = await harness.db.gitHubPrComment.findMany({
                where: { repoFullName: "acme/web", prNumber: 99 },
            });
            expect(rows).toHaveLength(1);
            expect(rows[0]!.commentId).toBe("comment-2");
        });
    },
});
