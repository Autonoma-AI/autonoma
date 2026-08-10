import { ApplicationArchitecture } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import { expect } from "vitest";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";

/**
 * A never-linked application. `linkRepository` only resolves the deploy ref on an app's FIRST link,
 * so a case asserting that resolution cannot reuse the suite's shared app - earlier cases link it.
 */
function createUnlinkedApp(harness: APITestHarness, name: string) {
    return harness.services.applications.createApplication({
        name,
        organizationId: harness.organizationId,
        architecture: ApplicationArchitecture.WEB,
        url: "https://example.com",
        file: "s3://bucket/file.png",
    });
}

/**
 * Connects the organization to an installation, clearing any previous one first.
 *
 * The suite shares one database across cases, and `handleInstallation` now REFUSES to repoint an
 * organization at a second GitHub account - that silent repoint is the bug it exists to prevent.
 * Cases that merely need some installation to exist (so `listRepositories` / `linkRepository` have
 * something to resolve through) therefore have to disconnect first, rather than leaning on an
 * overwrite that no longer happens. Cases asserting `handleInstallation`'s own behaviour call it
 * directly instead.
 */
async function connectInstallation(harness: APITestHarness, installationId: number) {
    await harness.db.gitHubInstallation.deleteMany({ where: { organizationId: harness.organizationId } });
    await harness.services.github.handleInstallation(installationId, harness.organizationId, {
        login: "test-org",
        id: 999,
        type: "Organization",
        createdAt: new Date(),
    });
}

apiTestSuite({
    name: "GitHubInstallationService",
    seed: async ({ harness }) => {
        const fakeClient = harness.githubApp.defaultClient;

        const app = await harness.services.applications.createApplication({
            name: "Test App",
            organizationId: harness.organizationId,
            architecture: ApplicationArchitecture.WEB,
            url: "https://example.com",
            file: "s3://bucket/file.png",
        });

        return { app, fakeClient };
    },
    cases: (test) => {
        test("handleInstallation upserts installation", async ({ harness }) => {
            await harness.services.github.handleInstallation(12345, harness.organizationId, {
                login: "test-org",
                id: 999,
                type: "Organization",
                createdAt: new Date(),
            });

            const installation = await harness.db.gitHubInstallation.findUnique({
                where: { organizationId: harness.organizationId },
            });

            expect(installation).not.toBeNull();
            expect(installation!.installationId).toBe(12345);
            expect(installation!.accountLogin).toBe("test-org");
            expect(installation!.status).toBe("active");
        });

        test("handleInstallation updates existing installation on re-install", async ({ harness }) => {
            await harness.services.github.handleInstallation(12345, harness.organizationId, {
                login: "test-org",
                id: 999,
                type: "Organization",
                createdAt: new Date(),
            });

            const outcome = await harness.services.github.handleInstallation(12345, harness.organizationId, {
                login: "new-org-name",
                id: 999,
                type: "Organization",
                createdAt: new Date(),
            });

            const installation = await harness.db.gitHubInstallation.findUnique({
                where: { organizationId: harness.organizationId },
            });

            expect(outcome.status).toBe("reconnected");
            expect(installation!.accountLogin).toBe("new-org-name");
        });

        test("handleInstallation refuses a second GitHub account and leaves the first untouched", async ({
            harness,
        }) => {
            // Explicit rather than inherited from the preceding case: the whole point is what
            // happens to an EXISTING connection, so this case owns setting one up.
            await harness.db.gitHubInstallation.deleteMany({ where: { organizationId: harness.organizationId } });
            await harness.services.github.handleInstallation(12345, harness.organizationId, {
                login: "first-account",
                id: 999,
                type: "Organization",
                createdAt: new Date(),
            });

            const outcome = await harness.services.github.handleInstallation(67890, harness.organizationId, {
                login: "second-account",
                id: 1000,
                type: "Organization",
                createdAt: new Date(),
            });

            expect(outcome).toEqual({
                status: "conflict",
                connectedAccountLogin: "first-account",
                // The installation the user is told to uninstall in order to switch accounts,
                // plus the account kind - the GitHub URL 404s on the wrong form.
                connectedInstallationId: 12345,
                connectedAccountType: "Organization",
                attemptedAccountLogin: "second-account",
            });

            // The point of the guard: the working connection survives byte-for-byte. Before it,
            // this row silently became the second account and every app linked to the first
            // stopped resolving.
            const installation = await harness.db.gitHubInstallation.findUnique({
                where: { organizationId: harness.organizationId },
            });
            expect(installation!.installationId).toBe(12345);
            expect(installation!.accountLogin).toBe("first-account");
            expect(installation!.status).toBe("active");
        });

        test("handleInstallation adopts a different account after the previous one was uninstalled", async ({
            harness,
        }) => {
            await harness.db.gitHubInstallation.deleteMany({ where: { organizationId: harness.organizationId } });
            await harness.services.github.handleInstallation(31410, harness.organizationId, {
                login: "old-account",
                id: 777,
                type: "Organization",
                createdAt: new Date(),
            });
            // Uninstalling on GitHub keeps the row as a tombstone rather than removing it.
            await harness.services.github.handleUninstall(31410);

            const outcome = await harness.services.github.handleInstallation(31411, harness.organizationId, {
                login: "new-account",
                id: 778,
                type: "Organization",
                createdAt: new Date(),
            });

            // Nothing live was left to protect, so this is a fresh connection - not a conflict, and
            // not a "reconnect" to an installation GitHub already told us was gone.
            expect(outcome).toEqual({ status: "connected", accountLogin: "new-account" });

            const installation = await harness.db.gitHubInstallation.findUnique({
                where: { organizationId: harness.organizationId },
            });
            expect(installation!.installationId).toBe(31411);
            expect(installation!.accountLogin).toBe("new-account");
            expect(installation!.status).toBe("active");
        });

        /**
         * The defence that actually stops a state replay. Signed state names an organization but
         * never an installation, so someone can present their own valid state with an installation
         * id they merely guessed. Requiring the installation to have been created moments ago is
         * what makes an enumerated id useless - a real callback always arrives right after GitHub
         * creates the installation.
         */
        test("handleInstallation refuses to bind an installation that was not created recently", async ({
            harness,
        }) => {
            await harness.db.gitHubInstallation.deleteMany({ where: { organizationId: harness.organizationId } });
            const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);

            const outcome = await harness.services.github.handleInstallation(52001, harness.organizationId, {
                login: "someone-elses-account",
                id: 4242,
                type: "Organization",
                createdAt: anHourAgo,
            });

            expect(outcome).toEqual({ status: "stale_installation" });
            const installation = await harness.db.gitHubInstallation.findUnique({
                where: { organizationId: harness.organizationId },
            });
            expect(installation).toBeNull();
        });

        /** The same age is fine when refreshing a binding this organization already holds. */
        test("handleInstallation still refreshes an old installation the organization already has", async ({
            harness,
        }) => {
            await harness.db.gitHubInstallation.deleteMany({ where: { organizationId: harness.organizationId } });
            await harness.services.github.handleInstallation(52002, harness.organizationId, {
                login: "acme",
                id: 4243,
                type: "Organization",
                createdAt: new Date(),
            });

            const outcome = await harness.services.github.handleInstallation(52002, harness.organizationId, {
                login: "acme-renamed",
                id: 4243,
                type: "Organization",
                createdAt: new Date(Date.now() - 60 * 60 * 1000),
            });

            expect(outcome).toEqual({ status: "reconnected", accountLogin: "acme-renamed" });
        });

        /**
         * The state that made this unrecoverable in practice. A row can name an installation GitHub
         * will not honour - an uninstall whose webhook never arrived, or a database restored from
         * another environment, where every row names an installation of a DIFFERENT GitHub App.
         * Refusing new installs in favour of it left no way forward at all: the connect was blocked,
         * and the "uninstall it on GitHub" link offered as the escape 404s, because there is nothing
         * there to uninstall.
         */
        test("handleInstallation replaces an installation GitHub no longer honours", async ({ harness }) => {
            await harness.db.gitHubInstallation.deleteMany({ where: { organizationId: harness.organizationId } });
            await harness.services.github.handleInstallation(70001, harness.organizationId, {
                login: "stale-account",
                id: 900,
                type: "Organization",
                createdAt: new Date(),
            });

            // GitHub stops issuing tokens for it, and never told us.
            harness.githubApp.unavailableInstallations.add(70001);

            const outcome = await harness.services.github.handleInstallation(70002, harness.organizationId, {
                login: "new-account",
                id: 901,
                type: "Organization",
                createdAt: new Date(),
            });

            expect(outcome).toEqual({ status: "connected", accountLogin: "new-account" });
            const installation = await harness.db.gitHubInstallation.findUnique({
                where: { organizationId: harness.organizationId },
            });
            expect(installation!.installationId).toBe(70002);
            expect(installation!.status).toBe("active");
        });

        /** A live installation still blocks - the probe must not weaken the guard it protects. */
        test("handleInstallation still refuses a second account when the first one works", async ({ harness }) => {
            await harness.db.gitHubInstallation.deleteMany({ where: { organizationId: harness.organizationId } });
            await harness.services.github.handleInstallation(70010, harness.organizationId, {
                login: "live-account",
                id: 910,
                type: "Organization",
                createdAt: new Date(),
            });

            const outcome = await harness.services.github.handleInstallation(70011, harness.organizationId, {
                login: "second-account",
                id: 911,
                type: "Organization",
                createdAt: new Date(),
            });

            expect(outcome.status).toBe("conflict");
        });

        test("handleInstallation reports an installation already claimed by another organization", async ({
            harness,
        }) => {
            const otherOrg = await harness.db.organization.create({
                data: { name: "Other Org", slug: "other-org-claimed", status: "approved" },
            });
            await harness.services.github.handleInstallation(24680, otherOrg.id, {
                login: "taken-account",
                id: 555,
                type: "Organization",
                createdAt: new Date(),
            });

            // Start disconnected, so the conflict guard above cannot fire first and mask the
            // unique-constraint path this case exists to cover.
            await harness.db.gitHubInstallation.deleteMany({ where: { organizationId: harness.organizationId } });

            const outcome = await harness.services.github.handleInstallation(24680, harness.organizationId, {
                login: "taken-account",
                id: 555,
                type: "Organization",
                createdAt: new Date(),
            });

            expect(outcome).toEqual({ status: "claimed_elsewhere", attemptedAccountLogin: "taken-account" });

            // The other organization keeps it; nothing was written for the caller.
            const ours = await harness.db.gitHubInstallation.findUnique({
                where: { organizationId: harness.organizationId },
            });
            expect(ours).toBeNull();
        });

        /**
         * After an uninstall the row survives as a tombstone, and the UI reads `getInstallation` to
         * decide whether there is anything to configure. Returning the tombstone put a "Configure
         * GitHub App" button on screen pointing at an installation GitHub had forgotten - a 404 for
         * someone whose intent was to install fresh.
         */
        test("getInstallation hides a tombstone so the UI offers a fresh install", async ({ harness }) => {
            await connectInstallation(harness, 61001);
            await harness.services.github.handleUninstall(61001);

            await expect(harness.request().github.getInstallation()).resolves.toBeNull();

            // Still on record for the service, which needs it to adopt the row on the next install.
            const row = await harness.db.gitHubInstallation.findUnique({
                where: { organizationId: harness.organizationId },
            });
            expect(row!.status).toBe("deleted");
        });

        /** A suspended installation still exists on GitHub and comes back, so it stays visible. */
        test("getInstallation still surfaces a suspended installation", async ({ harness }) => {
            await connectInstallation(harness, 61002);
            await harness.services.github.handleSuspend(61002);

            const view = await harness.request().github.getInstallation();
            expect(view?.status).toBe("suspended");
        });

        test("handleUninstall marks installation as deleted", async ({ harness }) => {
            await connectInstallation(harness, 55555);

            await harness.services.github.handleUninstall(55555);

            const installation = await harness.db.gitHubInstallation.findUnique({
                where: { organizationId: harness.organizationId },
            });

            expect(installation!.status).toBe("deleted");
        });

        test("handleSuspend marks installation as suspended", async ({ harness }) => {
            await connectInstallation(harness, 66666);

            await harness.services.github.handleSuspend(66666);

            const installation = await harness.db.gitHubInstallation.findUnique({
                where: { organizationId: harness.organizationId },
            });

            expect(installation!.status).toBe("suspended");
        });

        test("listRepositories returns repos from GitHub API with linked app info", async ({
            harness,
            seedResult: { app, fakeClient },
        }) => {
            fakeClient.addRepository({
                id: 2001,
                name: "my-repo",
                fullName: "org/my-repo",
                defaultBranch: "main",
                private: false,
            });
            fakeClient.addRepository({
                id: 2002,
                name: "other-repo",
                fullName: "org/other-repo",
                defaultBranch: "main",
                private: false,
            });

            await connectInstallation(harness, 77777);

            // Link app to first repo
            await harness.db.application.update({
                where: { id: app.id },
                data: { githubRepositoryId: 2001 },
            });

            const { repos, unavailable } = await harness.services.github.listRepositories(harness.organizationId);
            expect(repos).toHaveLength(2);
            expect(unavailable).toBeUndefined();

            const linkedRepo = repos.find((r) => r.id === 2001);
            expect(linkedRepo?.applicationId).toBe(app.id);

            const unlinkedRepo = repos.find((r) => r.id === 2002);
            expect(unlinkedRepo?.applicationId).toBeUndefined();
        });

        test("listRepositories reports an empty, complete list when the org has no installation", async ({
            harness,
        }) => {
            const listing = await harness.services.github.listRepositories("nonexistent-org-id");
            // An org that connected nothing HAS no repositories - that is an answer, not a
            // failed read, so callers must not warn that the list might be short.
            expect(listing).toEqual({ repos: [] });
        });

        test("linkRepository sets githubRepositoryId on application", async ({
            harness,
            seedResult: { app, fakeClient },
        }) => {
            fakeClient.addRepository({
                id: 3001,
                name: "config-repo",
                fullName: "org/config-repo",
                defaultBranch: "main",
                private: false,
            });

            await connectInstallation(harness, 88888);

            await harness.services.github.linkRepository(harness.organizationId, app.id, 3001);

            const updated = await harness.db.application.findUnique({ where: { id: app.id } });
            expect(updated!.githubRepositoryId).toBe(3001);
        });

        test("linkRepository sets the main-branch deploy ref to the repo's default branch", async ({
            harness,
            seedResult: { fakeClient },
        }) => {
            const app = await createUnlinkedApp(harness, "Master Default App");
            fakeClient.addRepository({
                id: 3009,
                name: "master-repo",
                fullName: "org/master-repo",
                defaultBranch: "master",
                private: false,
            });
            await connectInstallation(harness, 88_890);

            await harness.services.github.linkRepository(harness.organizationId, app.id, 3009);

            const branch = await harness.db.application.findUniqueOrThrow({
                where: { id: app.id },
                select: { mainBranch: { select: { name: true, mainInfo: { select: { githubRef: true } } } } },
            });
            expect(branch.mainBranch?.name).toBe("master");
            expect(branch.mainBranch?.mainInfo?.githubRef).toBe("master");
        });

        test("auditTrunkPins finds an app whose trunk drifted off the repo default, and repairTrunkPin fixes it", async ({
            harness,
            seedResult: { fakeClient },
        }) => {
            const app = await createUnlinkedApp(harness, "Mispinned Trunk App");
            fakeClient.addRepository({
                id: 3021,
                name: "mispinned-repo",
                fullName: "org/mispinned-repo",
                defaultBranch: "master",
                private: false,
            });
            await connectInstallation(harness, 88_893);
            await harness.services.github.linkRepository(harness.organizationId, app.id, 3021);

            // Reproduce the old behaviour: choosing a deploy branch rewrote the trunk.
            const appRow = await harness.db.application.findUniqueOrThrow({
                where: { id: app.id },
                select: { mainBranchId: true },
            });
            const mainBranchId = appRow.mainBranchId;
            if (mainBranchId == null) throw new Error("seeded app has no main branch");
            await harness.db.branch.update({ where: { id: mainBranchId }, data: { name: "autonoma-integration" } });
            await harness.db.mainBranchInfo.updateMany({
                where: { branchId: mainBranchId },
                data: { githubRef: "autonoma-integration" },
            });
            await harness.db.application.update({
                where: { id: app.id },
                data: { previewDeployRef: "autonoma-integration" },
            });

            const findings = await harness.services.github.auditTrunkPins();
            const finding = findings.find((candidate) => candidate.applicationId === app.id);
            expect(finding).toMatchObject({ trunkRef: "autonoma-integration", defaultBranch: "master" });

            const repaired = await harness.services.github.repairTrunkPin(app.id);

            expect(repaired).toEqual({ from: "autonoma-integration", to: "master" });
            const after = await harness.db.application.findUniqueOrThrow({
                where: { id: app.id },
                select: {
                    previewDeployRef: true,
                    mainBranch: { select: { name: true, mainInfo: { select: { githubRef: true } } } },
                },
            });
            expect(after.mainBranch?.name).toBe("master");
            expect(after.mainBranch?.mainInfo?.githubRef).toBe("master");
            // The base preview keeps building the branch that carries the config.
            expect(after.previewDeployRef).toBe("autonoma-integration");
        });

        test("repairTrunkPin fixes a trunk whose githubRef drifted while its branch name did not", async ({
            harness,
            seedResult: { fakeClient },
        }) => {
            const app = await createUnlinkedApp(harness, "Half Drifted Trunk App");
            fakeClient.addRepository({
                id: 3023,
                name: "half-drifted-repo",
                fullName: "org/half-drifted-repo",
                defaultBranch: "main",
                private: false,
            });
            await connectInstallation(harness, 88_894);
            await harness.services.github.linkRepository(harness.organizationId, app.id, 3023);

            // The state a Vercel production deploy used to leave behind: githubRef
            // corrected on its own, branch.name untouched. Two production apps are
            // like this, and the audit flags them by githubRef.
            const appRow = await harness.db.application.findUniqueOrThrow({
                where: { id: app.id },
                select: { mainBranchId: true },
            });
            const mainBranchId = appRow.mainBranchId;
            if (mainBranchId == null) throw new Error("seeded app has no main branch");
            await harness.db.mainBranchInfo.updateMany({
                where: { branchId: mainBranchId },
                data: { githubRef: "aws-staging" },
            });

            const findings = await harness.services.github.auditTrunkPins();
            expect(findings.find((candidate) => candidate.applicationId === app.id)).toMatchObject({
                trunkRef: "aws-staging",
                defaultBranch: "main",
            });

            const repaired = await harness.services.github.repairTrunkPin(app.id);

            // Would have returned { from: "main", to: "main" } and changed nothing,
            // because the no-op guard only looked at branch.name.
            expect(repaired).toEqual({ from: "aws-staging", to: "main" });
            const after = await harness.db.application.findUniqueOrThrow({
                where: { id: app.id },
                select: { mainBranch: { select: { name: true, mainInfo: { select: { githubRef: true } } } } },
            });
            expect(after.mainBranch?.mainInfo?.githubRef).toBe("main");
            expect(after.mainBranch?.name).toBe("main");
        });

        test("a push reconciles a trunk that drifted from the repository default branch", async ({
            harness,
            seedResult: { fakeClient },
        }) => {
            const app = await createUnlinkedApp(harness, "Renamed Default App");
            fakeClient.addRepository({
                id: 3025,
                name: "renamed-default-repo",
                fullName: "org/renamed-default-repo",
                defaultBranch: "main",
                private: false,
            });
            await connectInstallation(harness, 88_895);
            await harness.services.github.linkRepository(harness.organizationId, app.id, 3025);
            await harness.db.application.update({
                where: { id: app.id },
                data: { previewDeployRef: "autonoma-integration" },
            });

            // The repo's default branch is renamed on GitHub; the next push carries it.
            await harness.services.github.reconcileTrunkFromPushWebhook(harness.organizationId, {
                ref: "refs/heads/trunk",
                after: "a".repeat(40),
                repository: { id: 3025, full_name: "org/renamed-default-repo", default_branch: "trunk" },
            });

            const after = await harness.db.application.findUniqueOrThrow({
                where: { id: app.id },
                select: {
                    previewDeployRef: true,
                    mainBranch: { select: { name: true, mainInfo: { select: { githubRef: true } } } },
                },
            });
            expect(after.mainBranch?.name).toBe("trunk");
            expect(after.mainBranch?.mainInfo?.githubRef).toBe("trunk");
            // The base preview keeps building whatever it was pointed at.
            expect(after.previewDeployRef).toBe("autonoma-integration");
        });

        test("a push leaves an already-correct trunk alone", async ({ harness, seedResult: { fakeClient } }) => {
            const app = await createUnlinkedApp(harness, "Correct Trunk App");
            fakeClient.addRepository({
                id: 3026,
                name: "correct-trunk-repo",
                fullName: "org/correct-trunk-repo",
                defaultBranch: "master",
                private: false,
            });
            await connectInstallation(harness, 88_896);
            await harness.services.github.linkRepository(harness.organizationId, app.id, 3026);

            await harness.services.github.reconcileTrunkFromPushWebhook(harness.organizationId, {
                ref: "refs/heads/feature",
                after: "b".repeat(40),
                repository: { id: 3026, full_name: "org/correct-trunk-repo", default_branch: "master" },
            });

            const after = await harness.db.application.findUniqueOrThrow({
                where: { id: app.id },
                select: { mainBranch: { select: { name: true } } },
            });
            expect(after.mainBranch?.name).toBe("master");
        });

        test("linkRepository does not overwrite a user-chosen deploy branch on re-link", async ({
            harness,
            seedResult: { fakeClient },
        }) => {
            const app = await createUnlinkedApp(harness, "Relink App");
            fakeClient.addRepository({
                id: 3011,
                name: "relink-repo",
                fullName: "org/relink-repo",
                defaultBranch: "master",
                private: false,
            });
            await connectInstallation(harness, 88_891);

            // First link resolves the deploy ref to the repo default.
            await harness.services.github.linkRepository(harness.organizationId, app.id, 3011);
            const afterFirstLink = await harness.db.application.findUniqueOrThrow({
                where: { id: app.id },
                select: { mainBranch: { select: { name: true } } },
            });
            expect(afterFirstLink.mainBranch?.name).toBe("master");

            // The user then picks a specific branch.
            const appRow = await harness.db.application.findUniqueOrThrow({
                where: { id: app.id },
                select: { mainBranchId: true },
            });
            const mainBranchId = appRow.mainBranchId;
            if (mainBranchId == null) throw new Error("seeded app has no main branch");
            await harness.db.branch.update({ where: { id: mainBranchId }, data: { name: "feature-x" } });
            await harness.db.mainBranchInfo.updateMany({
                where: { branchId: mainBranchId },
                data: { githubRef: "feature-x" },
            });

            // Re-linking the same repo must NOT reset that choice back to the default.
            await harness.services.github.linkRepository(harness.organizationId, app.id, 3011);

            const branch = await harness.db.application.findUniqueOrThrow({
                where: { id: app.id },
                select: { mainBranch: { select: { name: true, mainInfo: { select: { githubRef: true } } } } },
            });
            expect(branch.mainBranch?.name).toBe("feature-x");
            expect(branch.mainBranch?.mainInfo?.githubRef).toBe("feature-x");
        });

        test("linkRepository throws NotFoundError for nonexistent app", async ({ harness }) => {
            await connectInstallation(harness, 99999);

            await expect(
                harness.services.github.linkRepository(harness.organizationId, "nonexistent-app-id", 1234),
            ).rejects.toThrow(NotFoundError);
        });

        test("disconnect removes installation and clears githubRepositoryId", async ({
            harness,
            seedResult: { app },
        }) => {
            await connectInstallation(harness, 11111);

            await harness.db.application.update({
                where: { id: app.id },
                data: { githubRepositoryId: 5001 },
            });

            await harness.services.github.disconnect(harness.organizationId);

            const installation = await harness.db.gitHubInstallation.findUnique({
                where: { organizationId: harness.organizationId },
            });
            expect(installation).toBeNull();

            const updatedApp = await harness.db.application.findUnique({ where: { id: app.id } });
            expect(updatedApp!.githubRepositoryId).toBeNull();
        });

        /**
         * The uninstall call is authenticated as the APP, not the installation - GitHub rejects an
         * installation token on that endpoint. When it fails for any other reason the app is still
         * installed on the account, and the caller has to be able to say so: reporting plain
         * success is how someone comes away believing they uninstalled something they did not.
         */
        test("disconnect reports whether GitHub actually removed the installation", async ({ harness }) => {
            await connectInstallation(harness, 80001);

            const ok = await harness.services.github.disconnect(harness.organizationId);
            expect(ok).toEqual({ removedFromGitHub: true, accountLogin: "test-org" });
            expect(harness.githubApp.deletedInstallations).toContain(80001);
        });

        test("disconnect still clears locally when GitHub refuses, and says so", async ({ harness }) => {
            await connectInstallation(harness, 80002);
            harness.githubApp.failDeleteInstallation.add(80002);

            const result = await harness.services.github.disconnect(harness.organizationId);

            expect(result.removedFromGitHub).toBe(false);
            // Cleared regardless - leaving the row would strand the organization with a connection
            // it cannot use and cannot remove.
            const row = await harness.db.gitHubInstallation.findUnique({
                where: { organizationId: harness.organizationId },
            });
            expect(row).toBeNull();
        });

        test("disconnect throws NotFoundError when no installation", async ({ harness }) => {
            await expect(harness.services.github.disconnect("nonexistent-org-id")).rejects.toThrow(NotFoundError);
        });
    },
});
