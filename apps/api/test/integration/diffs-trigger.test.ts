import type { PrismaClient } from "@autonoma/db";
import { ApplicationArchitecture, TriggerSource } from "@autonoma/db";
import { BadRequestError, NotFoundError } from "@autonoma/errors";
import { expect } from "vitest";
import { apiTestSuite } from "../api-test";

/** Open the run a workflow would have opened for this head, so the attach path has something to attach to. */
async function openRunFor(db: PrismaClient, branchId: string, headSha: string): Promise<string> {
    const snapshot = await db.branchSnapshot.create({
        data: { branchId, status: "processing", source: TriggerSource.WEBHOOK, headSha },
        select: { id: true },
    });
    await db.branch.update({ where: { id: branchId }, data: { pendingSnapshotId: snapshot.id } });
    return snapshot.id;
}

async function setActiveSnapshotHeadSha(db: PrismaClient, branchId: string, headSha: string): Promise<void> {
    const branch = await db.branch.findUniqueOrThrow({
        where: { id: branchId },
        select: { activeSnapshotId: true },
    });
    if (branch.activeSnapshotId == null) {
        throw new Error(`Branch ${branchId} has no active snapshot to update`);
    }
    await db.branchSnapshot.update({
        where: { id: branch.activeSnapshotId },
        data: { headSha },
    });
}

apiTestSuite({
    name: "DiffsTriggerService",
    seed: async ({ harness }) => {
        const service = harness.services.diffsTrigger;
        const fakeClient = harness.githubApp.defaultClient;

        fakeClient.addRepository({
            id: 1001,
            name: "my-repo",
            fullName: "org/my-repo",
            defaultBranch: "main",
            commits: ["initial-sha"],
        });

        for (const prNum of [10, 20, 30, 40, 50, 60, 70, 75, 76]) {
            fakeClient.addPullRequest("org/my-repo", {
                number: prNum,
                title: `Test PR #${prNum}`,
                headRef: `feature/branch-${prNum}`,
                baseSha: "initial-sha",
                commits: [`head-sha-${prNum}`],
            });
        }

        const app = await harness.services.applications.createApplication({
            name: "Test App",
            organizationId: harness.organizationId,
            architecture: ApplicationArchitecture.WEB,
            url: "https://example.com",
            file: "s3://bucket/file.png",
        });

        await harness.db.application.update({
            where: { id: app.id },
            data: { githubRepositoryId: 1001 },
        });

        // This suite exercises the live flow throughout: a pull request on an application still being set up is
        // refused before a branch is created, which `parks the app mid-onboarding` below covers deliberately.
        await harness.db.onboardingState.update({
            where: { applicationId: app.id },
            data: { step: "completed" },
        });

        // Suites share one DB with no truncation and installation_id is globally unique, so ids must not repeat.
        await harness.services.github.handleInstallation(33333, harness.organizationId, {
            login: "test-org",
            id: 999,
            type: "Organization",
            createdAt: new Date(),
        });

        return { app, service };
    },
    cases: (test) => {
        // The Branch row is what puts a pull request on Home, so it must not exist for a pull request Autonoma
        // never reviewed. `upsertPrBranch` runs before the activation gate, so this check has to sit ahead of it.
        test("refuses a PR trigger and creates no branch while the app is still being set up", async ({
            harness,
            seedResult: { app, service },
        }) => {
            harness.startAnalysisRun.mockClear();
            await harness.db.onboardingState.update({
                where: { applicationId: app.id },
                data: { step: "previewkit_configuring" },
            });

            try {
                const result = await service.triggerPrDiffs({
                    organizationId: harness.organizationId,
                    repoId: 1001,
                    prNumber: 76,
                    url: "https://preview.example.com",
                });

                expect(result.skipped).toBe(true);
                expect(result.branchId).toBeUndefined();
                expect(harness.startAnalysisRun).not.toHaveBeenCalled();
                const branch = await harness.db.branch.findFirst({
                    where: { applicationId: app.id, prInfo: { prNumber: 76 } },
                    select: { id: true },
                });
                expect(branch).toBeNull();
            } finally {
                await harness.db.onboardingState.update({
                    where: { applicationId: app.id },
                    data: { step: "completed" },
                });
            }
        });

        // `/start analysis` on a not-yet-live app is a person asking for it by hand, which is exactly what the
        // `requested` bypass is for.
        test("an explicitly requested run still goes through while the app is being set up", async ({
            harness,
            seedResult: { app, service },
        }) => {
            harness.startAnalysisRun.mockClear();
            await harness.db.onboardingState.update({
                where: { applicationId: app.id },
                data: { step: "previewkit_configuring" },
            });

            try {
                const result = await service.triggerPrDiffs({
                    organizationId: harness.organizationId,
                    repoId: 1001,
                    prNumber: 75,
                    requested: true,
                });

                expect(result.branchId).toBeDefined();
            } finally {
                await harness.db.onboardingState.update({
                    where: { applicationId: app.id },
                    data: { step: "completed" },
                });
            }
        });

        test("triggers diffs for a new branch", async ({ harness, seedResult: { app, service } }) => {
            const result = await service.triggerPrDiffs({
                organizationId: harness.organizationId,
                repoId: 1001,
                prNumber: 10,
                url: "https://preview.example.com",
                webhookUrl: "https://webhook.example.com/hook",
                webhookHeaders: { "X-Auth": "secret" },
            });

            expect(result.branchId).toBeDefined();
            expect(result.skipped).toBeUndefined();

            const branch = await harness.db.branch.findUnique({
                where: { id: result.branchId },
                include: { prInfo: true },
            });
            expect(branch).not.toBeNull();
            expect(branch!.name).toBe("feature/branch-10");
            expect(branch!.prInfo?.prNumber).toBe(10);
            expect(branch!.applicationId).toBe(app.id);
            // The deployment is recorded here - this preview already exists, so the branch points at it at once.
            expect(branch!.deploymentId).not.toBeNull();
            // The run opens inside its workflow, so the trigger leaves no snapshot behind.
            expect(branch!.pendingSnapshotId).toBeNull();
            expect(branch!.activeSnapshotId).toBeNull();

            const deployment = await harness.db.branchDeployment.findUniqueOrThrow({
                where: { id: branch!.deploymentId! },
                include: { webDeployment: true },
            });
            expect(deployment.webhookUrl).toBe("https://webhook.example.com/hook");
            expect(deployment.webhookHeaders).toEqual({ "X-Auth": "secret" });
            expect(deployment.webDeployment!.url).toBe("https://preview.example.com");

            expect(harness.startAnalysisRun).toHaveBeenCalledWith(
                expect.objectContaining({ branchId: result.branchId, headSha: "head-sha-10" }),
            );
        });

        test("activation suppresses an automatic run but honors an explicitly requested one", async ({
            harness,
            seedResult: { service },
        }) => {
            harness.githubApp.defaultClient.addPullRequest("org/my-repo", {
                number: 80,
                title: "Test PR #80",
                headRef: "feature/branch-80",
                baseSha: "initial-sha",
                commits: ["head-sha-80"],
            });
            await harness.db.organizationSettings.upsert({
                where: { organizationId: harness.organizationId },
                create: { organizationId: harness.organizationId, activationEnabled: true },
                update: { activationEnabled: true },
            });

            // Automatic caller (no `requested`): suppressed under activation - no snapshot, no run.
            const automatic = await service.triggerPrDiffs({
                organizationId: harness.organizationId,
                repoId: 1001,
                prNumber: 80,
                url: "https://preview.example.com",
            });
            // Explicitly requested (a merge-gate trigger): bypasses the gate and runs.
            const requested = await service.triggerPrDiffs({
                organizationId: harness.organizationId,
                repoId: 1001,
                prNumber: 80,
                url: "https://preview.example.com",
                requested: true,
            });

            // Reset before asserting so a failure can't leak activation to the other shared-org tests.
            await harness.db.organizationSettings.update({
                where: { organizationId: harness.organizationId },
                data: { activationEnabled: false },
            });

            expect(automatic.skipped).toBe(true);
            expect(requested.skipped).toBeUndefined();
            // Only the explicit request reached the run starter.
            expect(harness.startAnalysisRun).toHaveBeenCalledWith(
                expect.objectContaining({ branchId: requested.branchId, headSha: "head-sha-80" }),
            );
        });

        // Dedupe of activation triggers racing on the same head: a second explicit request attaches to the run the
        // first opened rather than superseding it, so `/start analysis` twice does not cost two runs.
        test("attaches to the in-flight run for the same head instead of starting a duplicate", async ({
            harness,
            seedResult: { service },
        }) => {
            harness.githubApp.defaultClient.addPullRequest("org/my-repo", {
                number: 91,
                title: "Test PR #91",
                headRef: "feature/branch-91",
                baseSha: "initial-sha",
                commits: ["head-sha-91"],
            });
            const request = {
                organizationId: harness.organizationId,
                repoId: 1001,
                prNumber: 91,
                url: "https://preview.example.com",
                requested: true,
            };

            const first = await service.triggerPrDiffs(request);
            await openRunFor(harness.db, first.branchId, "head-sha-91");

            // The spy is suite-scoped, so measure the delta this second call causes.
            const triggersBefore = harness.startAnalysisRun.mock.calls.length;
            const second = await service.triggerPrDiffs(request);

            expect(second.skipped).toBeUndefined();
            // Attached to the run already under way - no second run started for the same head.
            expect(harness.startAnalysisRun.mock.calls.length - triggersBefore).toBe(0);
        });

        // Dedupe across trigger kinds: a preview-ready auto-run firing just after a `/start analysis` opened a run
        // for the same head must attach to it, not supersede the requested run.
        test("an auto-run-on-ready attaches to an in-flight requested run for the same head", async ({
            harness,
            seedResult: { app, service },
        }) => {
            harness.githubApp.defaultClient.addPullRequest("org/my-repo", {
                number: 92,
                title: "Test PR #92",
                headRef: "feature/branch-92",
                baseSha: "initial-sha",
                commits: ["head-sha-92"],
            });
            await harness.db.organizationSettings.upsert({
                where: { organizationId: harness.organizationId },
                create: { organizationId: harness.organizationId, activationEnabled: true },
                update: { activationEnabled: true },
            });
            await harness.db.applicationTriggerConfig.upsert({
                where: { applicationId: app.id },
                create: { applicationId: app.id, autoRunOnReadyForReview: true },
                update: { autoRunOnReadyForReview: true },
            });
            const request = {
                organizationId: harness.organizationId,
                repoId: 1001,
                prNumber: 92,
                url: "https://preview.example.com",
            };

            const requested = await service.triggerPrDiffs({ ...request, requested: true });
            await openRunFor(harness.db, requested.branchId, "head-sha-92");

            const triggersBefore = harness.startAnalysisRun.mock.calls.length;
            const autoRun = await service.triggerPrDiffs(request);

            // Reset before asserting so a failure cannot leak activation to the other shared-org tests.
            await harness.db.organizationSettings.update({
                where: { organizationId: harness.organizationId },
                data: { activationEnabled: false },
            });
            await harness.db.applicationTriggerConfig.update({
                where: { applicationId: app.id },
                data: { autoRunOnReadyForReview: false },
            });

            expect(autoRun.skipped).toBeUndefined();
            // The auto-run attached to the requested run rather than superseding it.
            expect(harness.startAnalysisRun.mock.calls.length - triggersBefore).toBe(0);
        });

        // The activation exception: for a repo opted into auto-run-on-ready, the automatic preview-ready run IS
        // the trigger, so it proceeds where an unconfigured repo's would be suppressed.
        test("under activation, an automatic run proceeds when the repo opted into auto-run-on-ready", async ({
            harness,
            seedResult: { app, service },
        }) => {
            harness.githubApp.defaultClient.addPullRequest("org/my-repo", {
                number: 93,
                title: "Test PR #93",
                headRef: "feature/branch-93",
                baseSha: "initial-sha",
                commits: ["head-sha-93"],
            });
            await harness.db.organizationSettings.upsert({
                where: { organizationId: harness.organizationId },
                create: { organizationId: harness.organizationId, activationEnabled: true },
                update: { activationEnabled: true },
            });
            await harness.db.applicationTriggerConfig.upsert({
                where: { applicationId: app.id },
                create: { applicationId: app.id, autoRunOnReadyForReview: true },
                update: { autoRunOnReadyForReview: true },
            });

            const automatic = await service.triggerPrDiffs({
                organizationId: harness.organizationId,
                repoId: 1001,
                prNumber: 93,
                url: "https://preview.example.com",
            });

            await harness.db.organizationSettings.update({
                where: { organizationId: harness.organizationId },
                data: { activationEnabled: false },
            });
            await harness.db.applicationTriggerConfig.update({
                where: { applicationId: app.id },
                data: { autoRunOnReadyForReview: false },
            });

            expect(automatic.skipped).toBeUndefined();
            expect(harness.startAnalysisRun).toHaveBeenCalledWith(
                expect.objectContaining({ branchId: automatic.branchId, headSha: "head-sha-93" }),
            );
        });

        // A requested run is the same run a push starts; the request only changes WHEN. In particular it does not
        // ask how the PR's preview is hosted - the run resolves that itself.
        test("a requested run bypasses the organization's activation gate", async ({
            harness,
            seedResult: { service },
        }) => {
            await harness.db.organizationSettings.upsert({
                where: { organizationId: harness.organizationId },
                create: { organizationId: harness.organizationId, activationEnabled: true },
                update: { activationEnabled: true },
            });
            const result = await service.triggerPrDiffs({
                organizationId: harness.organizationId,
                repoId: 1001,
                prNumber: 75,
                requested: true,
            });

            await harness.db.organizationSettings.update({
                where: { organizationId: harness.organizationId },
                data: { activationEnabled: false },
            });

            expect(result.skipped).toBeUndefined();
            expect(harness.startAnalysisRun).toHaveBeenCalledWith(expect.objectContaining({ headSha: "head-sha-75" }));
        });

        // The skip the merge gate turns into "already analyzed" - with `requested: true` bypassing the activation
        // gate, an unchanged head is the only thing left that can suppress a run.
        test("a requested run skips an unchanged head", async ({ harness, seedResult: { app, service } }) => {
            const branch = await harness.db.branch.create({
                data: {
                    name: "feature/branch-76",
                    applicationId: app.id,
                    organizationId: harness.organizationId,
                    prInfo: { create: { applicationId: app.id, prNumber: 76 } },
                },
            });
            const analyzed = await harness.db.branchSnapshot.create({
                data: {
                    branchId: branch.id,
                    status: "active",
                    source: TriggerSource.WEBHOOK,
                    headSha: "head-sha-76",
                },
            });
            await harness.db.branch.update({
                where: { id: branch.id },
                data: { activeSnapshotId: analyzed.id },
            });
            const triggersBefore = harness.startAnalysisRun.mock.calls.length;

            const result = await service.triggerPrDiffs({
                organizationId: harness.organizationId,
                repoId: 1001,
                prNumber: 76,
                requested: true,
            });

            expect(result.skipped).toBe(true);
            expect(harness.startAnalysisRun.mock.calls.length - triggersBefore).toBe(0);
        });

        test("triggers diffs for an existing branch", async ({ harness, seedResult: { app, service } }) => {
            const existingBranch = await harness.db.branch.create({
                data: {
                    name: "feature/branch-20",
                    applicationId: app.id,
                    organizationId: harness.organizationId,
                    prInfo: { create: { applicationId: app.id, prNumber: 20 } },
                },
            });

            const result = await service.triggerPrDiffs({
                organizationId: harness.organizationId,
                repoId: 1001,
                prNumber: 20,
                url: "https://preview.example.com",
                webhookUrl: "https://webhook.example.com/hook",
            });

            expect(result.branchId).toBe(existingBranch.id);

            const branch = await harness.db.branch.findUnique({ where: { id: result.branchId } });
            // The run opens inside its workflow, so the trigger leaves no snapshot behind.
            expect(branch!.activeSnapshotId).toBeNull();
            expect(branch!.pendingSnapshotId).toBeNull();
            expect(harness.startAnalysisRun).toHaveBeenCalledWith(
                expect.objectContaining({ branchId: existingBranch.id }),
            );
        });

        test("skips PR diffs when the head was already analyzed (re-delivered webhook)", async ({
            harness,
            seedResult: { app, service },
        }) => {
            const branchId = (
                await harness.db.branch.create({
                    data: {
                        name: "feature/branch-60",
                        applicationId: app.id,
                        organizationId: harness.organizationId,
                        prInfo: { create: { applicationId: app.id, prNumber: 60 } },
                    },
                    select: { id: true },
                })
            ).id;
            // Active snapshot head equals PR 60's head ("head-sha-60"), so a fresh
            // signal for the same head has nothing new to diff.
            const activeSnapshot = await harness.db.branchSnapshot.create({
                data: { branchId, status: "active", source: TriggerSource.WEBHOOK, headSha: "head-sha-60" },
                select: { id: true },
            });
            await harness.db.branch.update({
                where: { id: branchId },
                data: { activeSnapshotId: activeSnapshot.id },
            });

            const result = await service.triggerPrDiffs({
                organizationId: harness.organizationId,
                repoId: 1001,
                prNumber: 60,
                url: "https://preview.example.com",
                webhookUrl: "https://webhook.example.com/hook",
            });

            expect(result.skipped).toBe(true);
            // No new snapshot beyond the pre-existing active one, and no run asked for.
            const snapshots = await harness.db.branchSnapshot.findMany({ where: { branchId } });
            expect(snapshots).toHaveLength(1);
        });

        // With the gate enforced, only a PR merging INTO the app's trunk is in scope. A PR that targets another
        // branch is refused before a Branch is created - and the gate is absolute, so an explicit `/start analysis`
        // (requested: true) is refused too.
        test("skips a PR that does not target the app's trunk when the org enforces the gate", async ({
            harness,
            seedResult: { app, service },
        }) => {
            harness.githubApp.defaultClient.addPullRequest("org/my-repo", {
                number: 77,
                title: "Test PR #77",
                headRef: "feature/branch-77",
                baseSha: "initial-sha",
                commits: ["head-sha-77"],
            });
            // The fake reports the PR base as the repo default ("main"); point the app's trunk elsewhere so the
            // PR's base is no longer the trunk.
            await harness.db.mainBranchInfo.update({
                where: { applicationId: app.id },
                data: { githubRef: "develop" },
            });
            await harness.db.organizationSettings.upsert({
                where: { organizationId: harness.organizationId },
                create: { organizationId: harness.organizationId, enforceBaseTrunkGate: true },
                update: { enforceBaseTrunkGate: true },
            });
            const triggersBefore = harness.startAnalysisRun.mock.calls.length;

            try {
                const result = await service.triggerPrDiffs({
                    organizationId: harness.organizationId,
                    repoId: 1001,
                    prNumber: 77,
                    requested: true,
                });

                expect(result.skipped).toBe(true);
                expect(result.reason).toBe("base_not_trunk");
                // No run started, and no Branch created for the out-of-scope PR.
                expect(harness.startAnalysisRun.mock.calls.length - triggersBefore).toBe(0);
                const branch = await harness.db.branch.findFirst({
                    where: { applicationId: app.id, prInfo: { prNumber: 77 } },
                });
                expect(branch).toBeNull();
            } finally {
                // Restore the shared-org state (trunk + gate flag) for the other tests in this suite.
                await harness.db.mainBranchInfo.update({
                    where: { applicationId: app.id },
                    data: { githubRef: "main" },
                });
                await harness.db.organizationSettings.update({
                    where: { organizationId: harness.organizationId },
                    data: { enforceBaseTrunkGate: false },
                });
            }
        });

        // The gate is opt-in: with the org flag off (the default), an off-trunk PR is analyzed like any other.
        test("analyzes an off-trunk PR when the org has not enabled the gate (default)", async ({
            harness,
            seedResult: { app, service },
        }) => {
            harness.githubApp.defaultClient.addPullRequest("org/my-repo", {
                number: 78,
                title: "Test PR #78",
                headRef: "feature/branch-78",
                baseSha: "initial-sha",
                commits: ["head-sha-78"],
            });
            // Base ("main", the repo default) differs from the trunk, but the gate is off by default.
            await harness.db.mainBranchInfo.update({
                where: { applicationId: app.id },
                data: { githubRef: "develop" },
            });

            try {
                const result = await service.triggerPrDiffs({
                    organizationId: harness.organizationId,
                    repoId: 1001,
                    prNumber: 78,
                    requested: true,
                });

                expect(result.skipped).toBeUndefined();
                expect(harness.startAnalysisRun).toHaveBeenCalledWith(
                    expect.objectContaining({ branchId: result.branchId, headSha: "head-sha-78" }),
                );
            } finally {
                await harness.db.mainBranchInfo.update({
                    where: { applicationId: app.id },
                    data: { githubRef: "main" },
                });
            }
        });

        test("throws NotFoundError when no application linked to repo", async ({
            harness,
            seedResult: { service },
        }) => {
            await expect(
                service.triggerPrDiffs({
                    organizationId: harness.organizationId,
                    repoId: 9999,
                    prNumber: 50,
                    url: "https://preview.example.com",
                    webhookUrl: "https://webhook.example.com/hook",
                }),
            ).rejects.toThrow(NotFoundError);
        });

        test("triggerDiffs dispatches to PR flow when ref is not main and prNumber is set", async ({
            harness,
            seedResult: { service },
        }) => {
            const result = await service.triggerDiffs({
                organizationId: harness.organizationId,
                repoId: 1001,
                prNumber: 50,
                githubRef: "feature/branch-50",
                url: "https://preview.example.com",
                webhookUrl: "https://webhook.example.com/hook",
            });

            const branch = await harness.db.branch.findUniqueOrThrow({
                where: { id: result.branchId },
                include: { prInfo: true },
            });
            expect(branch.prInfo?.prNumber).toBe(50);
        });

        test("triggers diffs for the main branch", async ({ harness, seedResult: { app, service } }) => {
            harness.githubApp.defaultClient.pushCommit("org/my-repo", "main", "main-head-sha-1");
            await setActiveSnapshotHeadSha(harness.db, app.mainBranchId!, "previous-main-sha");

            const result = await service.triggerMainDiffs({
                organizationId: harness.organizationId,
                repoId: 1001,
                url: "https://preview.example.com",
                webhookUrl: "https://webhook.example.com/hook",
            });

            expect(result.branchId).toBe(app.mainBranchId);

            expect(harness.startAnalysisRun).toHaveBeenCalledWith(
                expect.objectContaining({ branchId: app.mainBranchId, headSha: "main-head-sha-1" }),
            );

            const branch = await harness.db.branch.findUniqueOrThrow({
                where: { id: result.branchId },
                include: { mainInfo: true, prInfo: true },
            });
            expect(branch.mainInfo).not.toBeNull();
            expect(branch.prInfo).toBeNull();
        });

        test("activation does not suppress a main-branch baseline run", async ({
            harness,
            seedResult: { app, service },
        }) => {
            harness.githubApp.defaultClient.pushCommit("org/my-repo", "main", "main-head-activation");
            await setActiveSnapshotHeadSha(harness.db, app.mainBranchId!, "previous-main-activation");
            await harness.db.organizationSettings.upsert({
                where: { organizationId: harness.organizationId },
                create: { organizationId: harness.organizationId, activationEnabled: true },
                update: { activationEnabled: true },
            });

            const result = await service.triggerMainDiffs({
                organizationId: harness.organizationId,
                repoId: 1001,
                url: "https://preview.example.com",
            });

            // Reset before asserting so a failure can't leak activation to the other shared-org tests.
            await harness.db.organizationSettings.update({
                where: { organizationId: harness.organizationId },
                data: { activationEnabled: false },
            });

            // Activation only gates automatic PR runs; the baseline must keep updating on main pushes.
            expect(result.skipped).toBeUndefined();
            expect(harness.startAnalysisRun).toHaveBeenCalledWith(
                expect.objectContaining({ branchId: app.mainBranchId, headSha: "main-head-activation" }),
            );
        });

        test("skips main diffs when the head already matches the active snapshot", async ({
            harness,
            seedResult: { app, service },
        }) => {
            harness.githubApp.defaultClient.pushCommit("org/my-repo", "main", "unchanged-main-sha");
            await setActiveSnapshotHeadSha(harness.db, app.mainBranchId!, "unchanged-main-sha");
            const before = await harness.db.branchSnapshot.count({ where: { branchId: app.mainBranchId! } });

            const result = await service.triggerMainDiffs({
                organizationId: harness.organizationId,
                repoId: 1001,
                url: "https://preview.example.com",
                webhookUrl: "https://webhook.example.com/hook",
            });

            expect(result.skipped).toBe(true);
            // No new snapshot was created for the unchanged head.
            const after = await harness.db.branchSnapshot.count({ where: { branchId: app.mainBranchId! } });
            expect(after).toBe(before);
        });

        test("triggerDiffs dispatches to main flow when ref matches main branch", async ({
            harness,
            seedResult: { app, service },
        }) => {
            harness.githubApp.defaultClient.pushCommit("org/my-repo", "main", "dispatcher-main-sha");
            await setActiveSnapshotHeadSha(harness.db, app.mainBranchId!, "dispatcher-base-sha");

            const result = await service.triggerDiffs({
                organizationId: harness.organizationId,
                repoId: 1001,
                githubRef: "main",
                url: "https://preview.example.com",
                webhookUrl: "https://webhook.example.com/hook",
            });

            expect(result.branchId).toBe(app.mainBranchId);
            expect(harness.startAnalysisRun).toHaveBeenCalledWith(
                expect.objectContaining({ headSha: "dispatcher-main-sha" }),
            );
        });

        test("triggerDiffs dispatches to main flow when ref matches main even if prNumber is set", async ({
            harness,
            seedResult: { app, service },
        }) => {
            harness.githubApp.defaultClient.pushCommit("org/my-repo", "main", "main-wins-sha");
            await setActiveSnapshotHeadSha(harness.db, app.mainBranchId!, "main-wins-base-sha");

            const result = await service.triggerDiffs({
                organizationId: harness.organizationId,
                repoId: 1001,
                prNumber: 60,
                githubRef: "main",
                url: "https://preview.example.com",
                webhookUrl: "https://webhook.example.com/hook",
            });

            expect(result.branchId).toBe(app.mainBranchId);
            const branch = await harness.db.branch.findUniqueOrThrow({
                where: { id: result.branchId },
                include: { mainInfo: true, prInfo: true },
            });
            expect(branch.mainInfo).not.toBeNull();
            expect(branch.prInfo).toBeNull();
        });

        test("triggerDiffs throws BadRequestError for unknown ref", async ({ harness, seedResult: { service } }) => {
            await expect(
                service.triggerDiffs({
                    organizationId: harness.organizationId,
                    repoId: 1001,
                    githubRef: "feature/random",
                    url: "https://preview.example.com",
                    webhookUrl: "https://webhook.example.com/hook",
                }),
            ).rejects.toThrow(BadRequestError);
        });

        test("main branch trigger throws when no application linked to repo", async ({
            harness,
            seedResult: { service },
        }) => {
            await expect(
                service.triggerMainDiffs({
                    organizationId: harness.organizationId,
                    repoId: 9999,
                    url: "https://preview.example.com",
                    webhookUrl: "https://webhook.example.com/hook",
                }),
            ).rejects.toThrow(NotFoundError);
        });

        test("throws NotFoundError when no GitHub installation", async ({ harness, seedResult: { service } }) => {
            await harness.db.gitHubInstallation.deleteMany({
                where: { organizationId: harness.organizationId },
            });

            await expect(
                service.triggerPrDiffs({
                    organizationId: harness.organizationId,
                    repoId: 1001,
                    prNumber: 60,
                    url: "https://preview.example.com",
                    webhookUrl: "https://webhook.example.com/hook",
                }),
            ).rejects.toThrow(NotFoundError);
        });

        test("throws when PR not found on GitHub", async ({ harness, seedResult: { service } }) => {
            await expect(
                service.triggerPrDiffs({
                    organizationId: harness.organizationId,
                    repoId: 1001,
                    prNumber: 999,
                    url: "https://preview.example.com",
                    webhookUrl: "https://webhook.example.com/hook",
                }),
            ).rejects.toThrow();
        });
    },
});
