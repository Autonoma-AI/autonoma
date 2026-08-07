import { ApplicationArchitecture } from "@autonoma/db";
import { expect } from "vitest";
import { BranchContributorService } from "../../src/github/branch-contributor.service";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";

const PR_NUMBER = 7;

interface SeededPr {
    applicationId: string;
    branchId: string;
    repoId: number;
    repoFullName: string;
}

let nextRepoSeq = 0;

/**
 * Seed a linked application, an installation, a fake repo with one PR, and a tracked FeatureBranchInfo row.
 * The PR has two commits (alice, carol) and a Co-authored-by trailer for Bob; the opener is alice.
 */
async function seedTrackedPr(harness: APITestHarness): Promise<SeededPr> {
    const seq = nextRepoSeq++;
    const repoId = 4000 + seq;
    const repoFullName = `org/contributor-repo-${seq}`;
    const fakeClient = harness.githubApp.defaultClient;

    const app = await harness.services.applications.createApplication({
        name: `Contributor App ${crypto.randomUUID()}`,
        organizationId: harness.organizationId,
        architecture: ApplicationArchitecture.WEB,
        url: "https://example.com",
        file: "s3://bucket/file.png",
    });

    await harness.services.github.handleInstallation(500, harness.organizationId, {
        login: "org",
        id: 1,
        type: "Organization",
        createdAt: new Date(),
    });
    await harness.db.application.update({ where: { id: app.id }, data: { githubRepositoryId: repoId } });

    fakeClient.addRepository({
        id: repoId,
        name: `contributor-repo-${seq}`,
        fullName: repoFullName,
        commits: ["base"],
    });
    fakeClient.addPullRequest(repoFullName, {
        number: PR_NUMBER,
        title: "Add feature",
        headRef: "feature",
        baseSha: "base",
        commits: ["c1", "c2"],
    });
    fakeClient.setCommitDetails(repoFullName, "c1", { message: "feat: part one", authorLogin: "alice" });
    fakeClient.setCommitDetails(repoFullName, "c2", {
        message: "fix: part two\n\nCo-authored-by: Bob <bob@example.com>",
        authorLogin: "carol",
    });

    const branch = await harness.db.branch.create({
        data: { name: "feature", applicationId: app.id, organizationId: harness.organizationId },
    });
    await harness.db.featureBranchInfo.create({
        data: { branchId: branch.id, applicationId: app.id, prNumber: PR_NUMBER },
    });

    return { applicationId: app.id, branchId: branch.id, repoId, repoFullName };
}

function prPayload(repoId: number, repoFullName: string, openerLogin: string): Record<string, unknown> {
    return {
        pull_request: { number: PR_NUMBER, user: { login: openerLogin } },
        repository: { id: repoId, full_name: repoFullName },
    };
}

apiTestSuite({
    name: "BranchContributorService",
    cases: (test) => {
        test("resolveBranchContributors returns opener, pushers, and co-authors deduped", async ({ harness }) => {
            const { applicationId } = await seedTrackedPr(harness);
            const service = new BranchContributorService(harness.db, harness.services.github);

            const contributors = await service.resolveBranchContributors({
                organizationId: harness.organizationId,
                applicationId,
                prNumber: PR_NUMBER,
                openerLogin: "alice",
            });

            const alice = contributors.find((c) => c.login === "alice");
            const carol = contributors.find((c) => c.login === "carol");
            const bob = contributors.find((c) => c.email === "bob@example.com");

            expect(alice).toMatchObject({ isOpener: true });
            expect(carol).toMatchObject({ isOpener: false });
            expect(bob).toMatchObject({ displayName: "Bob" });
            expect(bob?.login).toBeUndefined();
            expect(contributors).toHaveLength(3);
        });

        test("resolveBranchContributors resolves the app by githubRepositoryId", async ({ harness }) => {
            const { repoId } = await seedTrackedPr(harness);
            const service = new BranchContributorService(harness.db, harness.services.github);

            const contributors = await service.resolveBranchContributors({
                organizationId: harness.organizationId,
                githubRepositoryId: repoId,
                prNumber: PR_NUMBER,
                openerLogin: "alice",
            });

            expect(contributors.find((c) => c.login === "alice")).toMatchObject({ isOpener: true });
            expect(contributors).toHaveLength(3);
        });

        test("resolveBranchContributors throws when no app is linked to the repository", async ({ harness }) => {
            const service = new BranchContributorService(harness.db, harness.services.github);

            await expect(
                service.resolveBranchContributors({
                    organizationId: harness.organizationId,
                    githubRepositoryId: 999_999,
                    prNumber: PR_NUMBER,
                    openerLogin: "alice",
                }),
            ).rejects.toThrow();
        });

        test("refreshFromWebhook persists a row per author plus the opener, with branchId", async ({ harness }) => {
            const { branchId, repoId, repoFullName } = await seedTrackedPr(harness);
            const service = new BranchContributorService(harness.db, harness.services.github);

            await service.refreshFromWebhook(harness.organizationId, prPayload(repoId, repoFullName, "alice"));

            const rows = await harness.db.branchContributor.findMany({
                where: { repoFullName, prNumber: PR_NUMBER },
                orderBy: { contributorKey: "asc" },
            });
            expect(rows.map((r) => r.contributorKey)).toEqual(["alice", "bob@example.com", "carol"]);

            const alice = rows.find((r) => r.contributorKey === "alice");
            expect(alice).toMatchObject({ login: "alice", isOpener: true, branchId });

            const bob = rows.find((r) => r.contributorKey === "bob@example.com");
            expect(bob).toMatchObject({ login: null, displayName: "Bob", email: "bob@example.com", isOpener: false });
        });

        test("refreshFromWebhook accumulates newly seen authors on a new push", async ({ harness }) => {
            const { repoId, repoFullName } = await seedTrackedPr(harness);
            const service = new BranchContributorService(harness.db, harness.services.github);
            const fakeClient = harness.githubApp.defaultClient;

            await service.refreshFromWebhook(harness.organizationId, prPayload(repoId, repoFullName, "alice"));

            // A later push adds a third commit by a new author.
            fakeClient.pushCommit(repoFullName, "feature", "c3");
            fakeClient.setCommitDetails(repoFullName, "c3", { message: "chore: more", authorLogin: "dana" });

            await service.refreshFromWebhook(harness.organizationId, prPayload(repoId, repoFullName, "alice"));

            const rows = await harness.db.branchContributor.findMany({
                where: { repoFullName, prNumber: PR_NUMBER },
                select: { contributorKey: true },
                orderBy: { contributorKey: "asc" },
            });
            expect(rows.map((r) => r.contributorKey)).toEqual(["alice", "bob@example.com", "carol", "dana"]);
        });

        test("refreshFromWebhook keeps an author whose commit was force-pushed away", async ({ harness }) => {
            const { repoFullName, repoId } = await seedTrackedPr(harness);
            const service = new BranchContributorService(harness.db, harness.services.github);
            const fakeClient = harness.githubApp.defaultClient;

            await service.refreshFromWebhook(harness.organizationId, prPayload(repoId, repoFullName, "alice"));

            // Force-push drops carol's commit (c2, which also carried Bob's co-author trailer).
            fakeClient.setBranchCommits(repoFullName, "feature", ["c1"]);

            await service.refreshFromWebhook(harness.organizationId, prPayload(repoId, repoFullName, "alice"));

            const rows = await harness.db.branchContributor.findMany({
                where: { repoFullName, prNumber: PR_NUMBER },
                select: { contributorKey: true },
                orderBy: { contributorKey: "asc" },
            });
            // carol and bob are retained as attribution history even though their commit is gone.
            expect(rows.map((r) => r.contributorKey)).toEqual(["alice", "bob@example.com", "carol"]);
        });

        test("refreshFromWebhook skips a PR with no tracked branch", async ({ harness }) => {
            const fakeClient = harness.githubApp.defaultClient;
            const repoId = 4900;
            const repoFullName = "org/untracked";
            const app = await harness.services.applications.createApplication({
                name: `Untracked App ${crypto.randomUUID()}`,
                organizationId: harness.organizationId,
                architecture: ApplicationArchitecture.WEB,
                url: "https://example.com",
                file: "s3://bucket/file.png",
            });
            await harness.services.github.handleInstallation(500, harness.organizationId, {
                login: "org",
                id: 1,
                type: "Organization",
                createdAt: new Date(),
            });
            await harness.db.application.update({ where: { id: app.id }, data: { githubRepositoryId: repoId } });
            fakeClient.addRepository({ id: repoId, name: "untracked", fullName: repoFullName, commits: ["base"] });

            const service = new BranchContributorService(harness.db, harness.services.github);
            await service.refreshFromWebhook(harness.organizationId, prPayload(repoId, repoFullName, "alice"));

            const rows = await harness.db.branchContributor.findMany({ where: { repoFullName } });
            expect(rows).toEqual([]);
        });

        test("resolveFixingPushAuthors returns the commit's authors incl. co-authors", async ({ harness }) => {
            const { applicationId } = await seedTrackedPr(harness);
            const service = new BranchContributorService(harness.db, harness.services.github);

            const authors = await service.resolveFixingPushAuthors({
                organizationId: harness.organizationId,
                applicationId,
                snapshotOrHeadSha: "c2",
            });

            expect(authors.find((a) => a.login === "carol")).toMatchObject({ isOpener: false });
            const bob = authors.find((a) => a.email === "bob@example.com");
            expect(bob).toMatchObject({ displayName: "Bob" });
            expect(bob?.login).toBeUndefined();
            expect(authors).toHaveLength(2);
        });

        test("resolveFixingPushAuthors resolves a snapshot id to its head SHA", async ({ harness }) => {
            const { applicationId, branchId } = await seedTrackedPr(harness);
            const snapshot = await harness.db.branchSnapshot.create({
                data: { branchId, source: "GITHUB_PUSH", headSha: "c1" },
            });
            const service = new BranchContributorService(harness.db, harness.services.github);

            const authors = await service.resolveFixingPushAuthors({
                organizationId: harness.organizationId,
                applicationId,
                snapshotOrHeadSha: snapshot.id,
            });

            expect(authors).toHaveLength(1);
            expect(authors[0]).toMatchObject({ login: "alice" });
        });
    },
});
