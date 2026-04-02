import { TriggerSource } from "@autonoma/db";
import { FakeGithubHistory } from "@autonoma/github";
import type { GitHubInstallationClient, GitHubApp } from "@autonoma/github";
import { expect, vi } from "vitest";
import {
    CommitDiffHandler,
    InvalidRepositoryFullNameError,
    MissingGithubRefError,
    MissingGithubRepositoryError,
    MissingLastHandledShaError,
} from "../src/commit-diff-handler";
import { SnapshotDraft } from "../src/snapshot-draft";
import { testUpdateSuite } from "./harness";

const noopTrigger = () => Promise.resolve();

function createStubApp(history: FakeGithubHistory): GitHubApp {
    const stubClient = { getHistory: () => history } as unknown as GitHubInstallationClient;
    return { getInstallationClient: () => Promise.resolve(stubClient) } as unknown as GitHubApp;
}

testUpdateSuite({
    name: "CommitDiffHandler",
    cases: (test) => {
        test("creates snapshot when new commits exist and triggers diff planner", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const installationId = await harness.createGitHubInstallation(organizationId);
            await harness.createGitHubRepository(installationId, applicationId, "owner/repo");

            const branchId = await harness.createBranch(organizationId, applicationId, {
                githubRef: "refs/heads/main",
                lastHandledSha: "abc123",
            });

            const githubHistory = new FakeGithubHistory();
            githubHistory.setNextSha("def456");
            const triggerDiffPlanner = vi.fn(() => Promise.resolve());
            const handler = new CommitDiffHandler(harness.db, createStubApp(githubHistory), triggerDiffPlanner);

            const snapshotId = await handler.checkForChanges(branchId);

            expect(snapshotId).toBeDefined();
            expect(triggerDiffPlanner).toHaveBeenCalledWith({ branchId });

            const branch = await harness.db.branch.findUniqueOrThrow({
                where: { id: branchId },
                select: { lastHandledSha: true, pendingSnapshotId: true },
            });
            expect(branch.lastHandledSha).toBe("def456");
            expect(branch.pendingSnapshotId).toBe(snapshotId);
        });

        test("returns undefined when no new commits", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const installationId = await harness.createGitHubInstallation(organizationId);
            await harness.createGitHubRepository(installationId, applicationId, "owner/repo");

            const branchId = await harness.createBranch(organizationId, applicationId, {
                githubRef: "refs/heads/main",
                lastHandledSha: "abc123",
            });

            const githubHistory = new FakeGithubHistory();
            githubHistory.setNextSha(undefined);
            const handler = new CommitDiffHandler(harness.db, createStubApp(githubHistory), noopTrigger);

            const snapshotId = await handler.checkForChanges(branchId);

            expect(snapshotId).toBeUndefined();

            const branch = await harness.db.branch.findUniqueOrThrow({
                where: { id: branchId },
                select: { lastHandledSha: true, pendingSnapshotId: true },
            });
            expect(branch.lastHandledSha).toBe("abc123");
            expect(branch.pendingSnapshotId).toBeNull();
        });

        test("returns undefined when branch already has pending snapshot", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const installationId = await harness.createGitHubInstallation(organizationId);
            await harness.createGitHubRepository(installationId, applicationId, "owner/repo");

            const branchId = await harness.createBranch(organizationId, applicationId, {
                githubRef: "refs/heads/main",
                lastHandledSha: "abc123",
            });

            // Create a pending snapshot first
            await SnapshotDraft.start({ db: harness.db, branchId });

            const githubHistory = new FakeGithubHistory();
            githubHistory.setNextSha("def456");
            const handler = new CommitDiffHandler(harness.db, createStubApp(githubHistory), noopTrigger);

            const snapshotId = await handler.checkForChanges(branchId);

            expect(snapshotId).toBeUndefined();

            // lastHandledSha should not have changed
            const branch = await harness.db.branch.findUniqueOrThrow({
                where: { id: branchId },
                select: { lastHandledSha: true },
            });
            expect(branch.lastHandledSha).toBe("abc123");
        });

        test("sets correct source and SHAs on snapshot", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const installationId = await harness.createGitHubInstallation(organizationId);
            await harness.createGitHubRepository(installationId, applicationId, "owner/repo");

            const branchId = await harness.createBranch(organizationId, applicationId, {
                githubRef: "refs/heads/main",
                lastHandledSha: "abc123",
            });

            const githubHistory = new FakeGithubHistory();
            githubHistory.setNextSha("def456");
            const handler = new CommitDiffHandler(harness.db, createStubApp(githubHistory), noopTrigger);

            const snapshotId = await handler.checkForChanges(branchId);
            expect(snapshotId).toBeDefined();

            const snapshot = await harness.db.branchSnapshot.findUniqueOrThrow({
                // biome-ignore lint/style/noNonNullAssertion: asserted above
                where: { id: snapshotId! },
                select: { source: true, headSha: true, baseSha: true },
            });

            expect(snapshot.source).toBe(TriggerSource.GITHUB_PUSH);
            expect(snapshot.headSha).toBe("def456");
            expect(snapshot.baseSha).toBe("abc123");
        });

        test("throws when branch has no githubRef", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const installationId = await harness.createGitHubInstallation(organizationId);
            await harness.createGitHubRepository(installationId, applicationId, "owner/repo");

            const branchId = await harness.createBranch(organizationId, applicationId, {
                lastHandledSha: "abc123",
            });

            const githubHistory = new FakeGithubHistory();
            const handler = new CommitDiffHandler(harness.db, createStubApp(githubHistory), noopTrigger);

            await expect(handler.checkForChanges(branchId)).rejects.toThrow(MissingGithubRefError);
        });

        test("throws when branch has no lastHandledSha", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const installationId = await harness.createGitHubInstallation(organizationId);
            await harness.createGitHubRepository(installationId, applicationId, "owner/repo");

            const branchId = await harness.createBranch(organizationId, applicationId, {
                githubRef: "refs/heads/main",
            });

            const githubHistory = new FakeGithubHistory();
            const handler = new CommitDiffHandler(harness.db, createStubApp(githubHistory), noopTrigger);

            await expect(handler.checkForChanges(branchId)).rejects.toThrow(MissingLastHandledShaError);
        });

        test("throws when repository fullName is malformed", async ({ harness, seedResult: { organizationId } }) => {
            const freshAppId = await harness.createApp(organizationId);
            const installationId = await harness.createGitHubInstallation(organizationId);
            await harness.createGitHubRepository(installationId, freshAppId, "invalid-no-slash");

            const branchId = await harness.createBranch(organizationId, freshAppId, {
                githubRef: "refs/heads/main",
                lastHandledSha: "abc123",
            });

            const githubHistory = new FakeGithubHistory();
            const handler = new CommitDiffHandler(harness.db, createStubApp(githubHistory), noopTrigger);

            await expect(handler.checkForChanges(branchId)).rejects.toThrow(InvalidRepositoryFullNameError);
        });

        test("throws when no GitHub repository linked to application", async ({
            harness,
            seedResult: { organizationId },
        }) => {
            const freshAppId = await harness.createApp(organizationId);
            const branchId = await harness.createBranch(organizationId, freshAppId, {
                githubRef: "refs/heads/main",
                lastHandledSha: "abc123",
            });

            const githubHistory = new FakeGithubHistory();
            const handler = new CommitDiffHandler(harness.db, createStubApp(githubHistory), noopTrigger);

            await expect(handler.checkForChanges(branchId)).rejects.toThrow(MissingGithubRepositoryError);
        });

        test("checkForChanges after activation triggers new snapshot", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const installationId = await harness.createGitHubInstallation(organizationId);
            await harness.createGitHubRepository(installationId, applicationId, "owner/repo");

            const branchId = await harness.createBranch(organizationId, applicationId, {
                githubRef: "refs/heads/main",
                lastHandledSha: "abc123",
            });

            const githubHistory = new FakeGithubHistory();
            githubHistory.setNextSha("def456");
            const handler = new CommitDiffHandler(harness.db, createStubApp(githubHistory), noopTrigger);

            // First commit creates a snapshot
            const firstSnapshotId = await handler.checkForChanges(branchId);
            expect(firstSnapshotId).toBeDefined();

            // Activate the snapshot (simulate finalization)
            const draft = await SnapshotDraft.loadPending({ db: harness.db, branchId });
            await draft.activate();

            // New commit arrives
            githubHistory.setNextSha("ghi789");
            const secondSnapshotId = await handler.checkForChanges(branchId);

            expect(secondSnapshotId).toBeDefined();
            expect(secondSnapshotId).not.toBe(firstSnapshotId);

            const branch = await harness.db.branch.findUniqueOrThrow({
                where: { id: branchId },
                select: { lastHandledSha: true },
            });
            expect(branch.lastHandledSha).toBe("ghi789");
        });
    },
});
