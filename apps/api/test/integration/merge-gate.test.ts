import { PostHogAnalytics } from "@autonoma/analytics";
import { ApplicationArchitecture } from "@autonoma/db";
import { BadRequestError } from "@autonoma/errors";
import { MERGE_GATE_SKIP_ACTION_IDENTIFIER } from "@autonoma/github/check";
import { expect } from "vitest";
import { MergeGateService } from "../../src/github/merge-gate.service";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";

interface CapturedEvent {
    event: string;
    properties?: Record<string, unknown>;
}

/** Records capture() calls (incl. the org group) so we can assert the merge-gate events without PostHog. */
class RecordingAnalytics extends PostHogAnalytics {
    public captures: CapturedEvent[] = [];

    override capture(
        _distinctId: string,
        event: string,
        properties?: Record<string, unknown>,
        _groups?: Record<string, string>,
    ): void {
        this.captures.push({ event, properties });
    }
}

const INSTALLATION_ID = 44_444;

apiTestSuite({
    name: "MergeGateService",
    seed: async ({ harness }) => {
        // One installation for the org; the fake app returns its defaultClient for any installation id.
        await harness.services.github.handleInstallation(
            INSTALLATION_ID,
            harness.organizationId,
            "test-org",
            999,
            "Organization",
        );
        return {};
    },
    cases: (test) => {
        test("postPending posts an in-progress check for an enabled org and nothing for a disabled org", async ({
            harness,
        }) => {
            const analytics = new RecordingAnalytics();
            const fixture = await createRepoApp(harness, "gate-post");

            // Disabled org (per-org flag off): no check, no row.
            await setGate(harness, { analysisEnabled: true, mergeGateEnabled: false });
            const disabled = new MergeGateService(harness.db, harness.githubApp, true, analytics);
            await disabled.postPending({ ...fixture.postParams });
            expect(fixture.fakeClient.checkRuns).toHaveLength(0);
            expect(
                await harness.db.gitHubCheckRun.findUnique({
                    where: { repoFullName_headSha: { repoFullName: fixture.repoFullName, headSha: "head-1" } },
                }),
            ).toBeNull();

            // Enabled org: an in-progress check is posted and persisted, idempotently per head.
            await setGate(harness, { analysisEnabled: true, mergeGateEnabled: true });
            const enabled = new MergeGateService(harness.db, harness.githubApp, true, analytics);
            await enabled.postPending({ ...fixture.postParams });
            await enabled.postPending({ ...fixture.postParams });

            expect(fixture.fakeClient.checkRuns).toHaveLength(1);
            expect(fixture.fakeClient.checkRuns[0]?.status).toBe("in_progress");
            const row = await harness.db.gitHubCheckRun.findUnique({
                where: { repoFullName_headSha: { repoFullName: fixture.repoFullName, headSha: "head-1" } },
            });
            expect(row?.prNumber).toBe(42);
        });

        test("applySkip records the open bugs and flips the check to neutral", async ({ harness }) => {
            const analytics = new RecordingAnalytics();
            await setGate(harness, { analysisEnabled: true, mergeGateEnabled: true });
            const service = new MergeGateService(harness.db, harness.githubApp, true, analytics);
            const fixture = await createRepoApp(harness, "gate-skip");

            // A snapshot at the PR head with a client_bug report (two open bugs).
            const snapshotId = await createSnapshotWithBugs(harness, fixture.appId, "head-1", [
                "checkout-submit",
                "cart-empties",
            ]);

            // Post the pending check, then simulate the worker having set it to failure.
            await service.postPending({ ...fixture.postParams });
            await harness.db.gitHubCheckRun.update({
                where: { repoFullName_headSha: { repoFullName: fixture.repoFullName, headSha: "head-1" } },
                data: { conclusion: "failure" },
            });
            const checkRunId = fixture.fakeClient.checkRuns[0]?.id;
            if (checkRunId == null) throw new Error("expected a check run to have been posted");

            await service.applySkip({
                organizationId: harness.organizationId,
                repoFullName: fixture.repoFullName,
                githubRepositoryId: fixture.repoId,
                headSha: "head-1",
                checkRunId,
                actorLogin: "dev-who-skipped",
                actionIdentifier: MERGE_GATE_SKIP_ACTION_IDENTIFIER,
            });

            const skip = await harness.db.skipRecord.findFirst({
                where: { repoFullName: fixture.repoFullName, headSha: "head-1" },
            });
            expect(skip?.actorLogin).toBe("dev-who-skipped");
            expect(skip?.openBugCount).toBe(2);
            expect(skip?.snapshotId).toBe(snapshotId);
            expect(skip?.openFindingIds).toEqual(["checkout-submit", "cart-empties"]);

            // The check is unblocked (neutral) on both GitHub and our store.
            expect(fixture.fakeClient.checkRuns[0]?.conclusion).toBe("neutral");
            const row = await harness.db.gitHubCheckRun.findUnique({
                where: { repoFullName_headSha: { repoFullName: fixture.repoFullName, headSha: "head-1" } },
            });
            expect(row?.conclusion).toBe("neutral");
            expect(analytics.captures.map((c) => c.event)).toContain("merge_gate.skipped");
        });

        test("applySkip is idempotent: a second click writes no duplicate record and re-flips the check", async ({
            harness,
        }) => {
            const analytics = new RecordingAnalytics();
            await setGate(harness, { analysisEnabled: true, mergeGateEnabled: true });
            const service = new MergeGateService(harness.db, harness.githubApp, true, analytics);
            const fixture = await createRepoApp(harness, "gate-skip-twice");
            await createSnapshotWithBugs(harness, fixture.appId, "head-1", ["only-bug"]);

            await service.postPending({ ...fixture.postParams });
            await harness.db.gitHubCheckRun.update({
                where: { repoFullName_headSha: { repoFullName: fixture.repoFullName, headSha: "head-1" } },
                data: { conclusion: "failure" },
            });
            const checkRunId = fixture.fakeClient.checkRuns[0]?.id;
            if (checkRunId == null) throw new Error("expected a check run to have been posted");

            const skipParams = {
                organizationId: harness.organizationId,
                repoFullName: fixture.repoFullName,
                githubRepositoryId: fixture.repoId,
                headSha: "head-1",
                checkRunId,
                actorLogin: "dev",
                actionIdentifier: MERGE_GATE_SKIP_ACTION_IDENTIFIER,
            };
            await service.applySkip(skipParams);
            await service.applySkip(skipParams);

            const records = await harness.db.skipRecord.findMany({
                where: { repoFullName: fixture.repoFullName, headSha: "head-1" },
            });
            expect(records).toHaveLength(1);
            expect(fixture.fakeClient.checkRuns[0]?.conclusion).toBe("neutral");
            expect(analytics.captures.filter((c) => c.event === "merge_gate.skipped")).toHaveLength(1);
        });

        test("applySkip ignores a non-skip requested_action", async ({ harness }) => {
            const analytics = new RecordingAnalytics();
            await setGate(harness, { analysisEnabled: true, mergeGateEnabled: true });
            const service = new MergeGateService(harness.db, harness.githubApp, true, analytics);
            const fixture = await createRepoApp(harness, "gate-skip-ignored");

            await service.applySkip({
                organizationId: harness.organizationId,
                repoFullName: fixture.repoFullName,
                githubRepositoryId: fixture.repoId,
                headSha: "head-1",
                checkRunId: "999",
                actorLogin: "dev",
                actionIdentifier: "some-other-button",
            });

            const skip = await harness.db.skipRecord.findFirst({
                where: { repoFullName: fixture.repoFullName, headSha: "head-1" },
            });
            expect(skip).toBeNull();
        });

        test("close persists merge facts and detects a bypass only when a failure head merged without a skip", async ({
            harness,
        }) => {
            const analytics = new RecordingAnalytics();
            await setGate(harness, { analysisEnabled: true, mergeGateEnabled: true });
            const service = new MergeGateService(harness.db, harness.githubApp, true, analytics);
            const fixture = await createRepoApp(harness, "gate-close");

            // A feature branch + a failing check on the merged head, no SkipRecord: a bypass.
            const branch = await harness.db.branch.create({
                data: { name: "feature/x", applicationId: fixture.appId, organizationId: harness.organizationId },
            });
            await harness.db.featureBranchInfo.create({
                data: { branchId: branch.id, applicationId: fixture.appId, prNumber: 42, prState: "open" },
            });
            await harness.db.gitHubCheckRun.create({
                data: {
                    repoFullName: fixture.repoFullName,
                    prNumber: 42,
                    headSha: "head-1",
                    checkRunId: "cr-1",
                    conclusion: "failure",
                },
            });

            await service.recordMergeAndDetectBypass({
                organizationId: harness.organizationId,
                repoFullName: fixture.repoFullName,
                githubRepositoryId: fixture.repoId,
                prNumber: 42,
                headSha: "head-1",
                merged: true,
                mergeCommitSha: "merge-sha",
                mergedByLogin: "merger",
                mergedAt: new Date("2026-07-21T00:00:00Z"),
            });

            const info = await harness.db.featureBranchInfo.findUnique({ where: { branchId: branch.id } });
            expect(info?.mergeCommitSha).toBe("merge-sha");
            expect(info?.mergedByLogin).toBe("merger");
            expect(info?.mergedAt).not.toBeNull();
            expect(analytics.captures.map((c) => c.event)).toContain("merge_gate.bypassed");

            // With a SkipRecord present, the same close is NOT a bypass.
            analytics.captures = [];
            await harness.db.skipRecord.create({
                data: {
                    organizationId: harness.organizationId,
                    repoFullName: fixture.repoFullName,
                    prNumber: 42,
                    headSha: "head-1",
                    actorLogin: "dev",
                    openBugCount: 1,
                    openFindingIds: ["x"],
                },
            });
            await service.recordMergeAndDetectBypass({
                organizationId: harness.organizationId,
                repoFullName: fixture.repoFullName,
                githubRepositoryId: fixture.repoId,
                prNumber: 42,
                headSha: "head-1",
                merged: true,
            });
            expect(analytics.captures.map((c) => c.event)).not.toContain("merge_gate.bypassed");
        });

        test("enableForOrg requires analysisEnabled and registers branch protection; disable de-registers it", async ({
            harness,
        }) => {
            const analytics = new RecordingAnalytics();
            const service = new MergeGateService(harness.db, harness.githubApp, true, analytics);
            const fixture = await createRepoApp(harness, "gate-enable");

            // Without analysisEnabled, enabling is refused.
            await setGate(harness, { analysisEnabled: false, mergeGateEnabled: false });
            await expect(service.enableForOrg(harness.organizationId)).rejects.toBeInstanceOf(BadRequestError);

            // With analysisEnabled, enabling flips the flag and requires `Autonoma` on all branches (via ruleset).
            await setGate(harness, { analysisEnabled: true, mergeGateEnabled: false });
            const result = await service.enableForOrg(harness.organizationId);
            expect(result.enabled).toBe(true);
            expect(result.protections.some((p) => p.result.status === "applied")).toBe(true);
            expect(
                fixture.fakeClient.requiredStatusCheckContexts(fixture.repoFullName, "Autonoma merge gate"),
            ).toContain("Autonoma");
            const enabled = await harness.db.organizationSettings.findUnique({
                where: { organizationId: harness.organizationId },
            });
            expect(enabled?.mergeGateEnabled).toBe(true);

            await service.disableForOrg(harness.organizationId);
            expect(
                fixture.fakeClient.requiredStatusCheckContexts(fixture.repoFullName, "Autonoma merge gate"),
            ).not.toContain("Autonoma");
            const disabled = await harness.db.organizationSettings.findUnique({
                where: { organizationId: harness.organizationId },
            });
            expect(disabled?.mergeGateEnabled).toBe(false);
        });
    },
});

interface RepoAppFixture {
    appId: string;
    repoId: number;
    repoFullName: string;
    fakeClient: APITestHarness["githubApp"]["defaultClient"];
    postParams: {
        organizationId: string;
        repoFullName: string;
        githubRepositoryId: number;
        prNumber: number;
        headSha: string;
    };
}

/** Create a fresh repo + linked application per test so rows never collide on the shared integration DB. */
async function createRepoApp(harness: APITestHarness, seed: string): Promise<RepoAppFixture> {
    const fakeClient = harness.githubApp.defaultClient;
    const repoId = Math.floor(Math.random() * 1_000_000) + 500_000;
    const repoFullName = `org/${seed}-${repoId}`;
    fakeClient.addRepository({
        id: repoId,
        name: `${seed}`,
        fullName: repoFullName,
        defaultBranch: "main",
        commits: ["base-1"],
    });

    const app = await harness.services.applications.createApplication({
        name: `${seed}-${repoId}`,
        organizationId: harness.organizationId,
        architecture: ApplicationArchitecture.WEB,
        url: "https://example.com",
        file: "s3://bucket/file.png",
    });
    await harness.db.application.update({ where: { id: app.id }, data: { githubRepositoryId: repoId } });

    return {
        appId: app.id,
        repoId,
        repoFullName,
        fakeClient,
        postParams: {
            organizationId: harness.organizationId,
            repoFullName,
            githubRepositoryId: repoId,
            prNumber: 42,
            headSha: "head-1",
        },
    };
}

async function setGate(
    harness: APITestHarness,
    flags: { analysisEnabled: boolean; mergeGateEnabled: boolean },
): Promise<void> {
    await harness.db.organizationSettings.upsert({
        where: { organizationId: harness.organizationId },
        create: { organizationId: harness.organizationId, ...flags },
        update: flags,
    });
}

/** A feature-branch snapshot at `headSha` with a client_bug report carrying the given finding keys. */
async function createSnapshotWithBugs(
    harness: APITestHarness,
    applicationId: string,
    headSha: string,
    findingKeys: string[],
): Promise<string> {
    const branch = await harness.db.branch.create({
        data: {
            name: `feature/${headSha}-${crypto.randomUUID()}`,
            applicationId,
            organizationId: harness.organizationId,
        },
    });
    const snapshot = await harness.db.branchSnapshot.create({
        data: { branchId: branch.id, source: "WEBHOOK", status: "active", headSha, baseSha: "base-1" },
    });
    await harness.db.analysisReport.create({
        data: {
            snapshotId: snapshot.id,
            verdict: "client_bug",
            organizationId: harness.organizationId,
            findings: {
                create: findingKeys.map((key, index) => ({
                    findingKey: key,
                    slug: key,
                    category: "client_bug",
                    headline: `Bug ${key}`,
                    displayOrder: index,
                    organizationId: harness.organizationId,
                })),
            },
        },
    });
    return snapshot.id;
}
