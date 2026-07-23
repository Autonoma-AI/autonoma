import { describe, expect, it } from "vitest";
import { FakeGitHubInstallationClient } from "./fake-github-installation-client";

describe("FakeGitHubInstallationClient comments", () => {
    it("stores and updates PR comments in memory", async () => {
        const client = new FakeGitHubInstallationClient();
        client.addRepository({ id: 1, name: "app", fullName: "autonoma/app" });

        const commentId = await client.postComment("autonoma/app", 7, "first body");
        await client.updateComment("autonoma/app", commentId, "updated body");

        expect(client.comments).toEqual([
            { id: commentId, repoFullName: "autonoma/app", prNumber: 7, body: "updated body" },
        ]);
    });

    it("deletes PR comments idempotently", async () => {
        const client = new FakeGitHubInstallationClient();
        client.addRepository({ id: 1, name: "app", fullName: "autonoma/app" });

        const commentId = await client.postComment("autonoma/app", 7, "body");
        await client.deleteComment("autonoma/app", commentId);
        expect(client.comments).toEqual([]);

        // Second delete is a no-op, matching GitHub's 404-tolerant contract.
        await client.deleteComment("autonoma/app", commentId);

        // The deleted comment can no longer be updated.
        await expect(client.updateComment("autonoma/app", commentId, "new body")).rejects.toThrow("not found");
    });
});

describe("FakeGitHubInstallationClient check runs", () => {
    it("creates then updates a check run in place", async () => {
        const client = new FakeGitHubInstallationClient();
        client.addRepository({ id: 1, name: "app", fullName: "autonoma/app" });

        const id = await client.createCheckRun({
            repoFullName: "autonoma/app",
            headSha: "sha-1",
            name: "Autonoma",
            status: "in_progress",
            title: "Analyzing",
            summary: "working",
        });

        await client.updateCheckRun({
            repoFullName: "autonoma/app",
            checkRunId: id,
            status: "completed",
            conclusion: "failure",
            title: "Found bugs",
            summary: "one bug",
        });

        expect(client.checkRuns).toEqual([
            {
                id,
                repoFullName: "autonoma/app",
                headSha: "sha-1",
                name: "Autonoma",
                status: "completed",
                conclusion: "failure",
                title: "Found bugs",
                summary: "one bug",
                actions: undefined,
            },
        ]);
    });

    it("tolerates updating a missing check run (404 no-op)", async () => {
        const client = new FakeGitHubInstallationClient();
        client.addRepository({ id: 1, name: "app", fullName: "autonoma/app" });

        await expect(
            client.updateCheckRun({
                repoFullName: "autonoma/app",
                checkRunId: "does-not-exist",
                status: "completed",
                conclusion: "neutral",
                title: "t",
                summary: "s",
            }),
        ).resolves.toBeUndefined();
        expect(client.checkRuns).toEqual([]);
    });
});

describe("FakeGitHubInstallationClient required-status-check ruleset", () => {
    it("requires and removes a status-check context across all branches", async () => {
        const client = new FakeGitHubInstallationClient();
        const params = { repoFullName: "autonoma/app", contextName: "Autonoma", rulesetName: "Autonoma merge gate" };

        expect(await client.requireStatusCheckOnAllBranches(params)).toEqual({ status: "applied" });
        expect(client.requiredStatusCheckContexts("autonoma/app", "Autonoma merge gate")).toEqual(["Autonoma"]);

        expect(
            await client.removeRequiredStatusCheckRuleset({
                repoFullName: "autonoma/app",
                rulesetName: "Autonoma merge gate",
            }),
        ).toEqual({ status: "applied" });
        expect(client.requiredStatusCheckContexts("autonoma/app", "Autonoma merge gate")).toEqual([]);
    });

    it("reports no_permission when the App lacks admin", async () => {
        const client = new FakeGitHubInstallationClient();
        client.setBranchProtectionBehavior("no_permission");

        const result = await client.requireStatusCheckOnAllBranches({
            repoFullName: "autonoma/app",
            contextName: "Autonoma",
            rulesetName: "Autonoma merge gate",
        });
        expect(result).toEqual({ status: "no_permission" });
    });
});
