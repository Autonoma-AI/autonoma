import { PostHogAnalytics } from "@autonoma/analytics";
import { ApplicationArchitecture } from "@autonoma/db";
import { BadRequestError } from "@autonoma/errors";
import { expect } from "vitest";
import { MergeGateService } from "../../src/github/merge-gate.service";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";
import { seedFindingGenerations } from "../seed-finding-generations";

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

        test("a /autonoma-skip comment records the open bugs + reason and flips the check to neutral", async ({
            harness,
        }) => {
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
            await setCheckConclusion(harness, fixture.repoFullName, "head-1", "failure");

            await service.applySkipFromCommentWebhook(
                harness.organizationId,
                skipCommentPayload(fixture, "/autonoma-skip hotfix for prod outage", "dev-who-skipped"),
            );

            const skip = await harness.db.skipRecord.findFirst({
                where: { repoFullName: fixture.repoFullName, headSha: "head-1" },
            });
            expect(skip?.actorLogin).toBe("dev-who-skipped");
            expect(skip?.openBugCount).toBe(2);
            expect(skip?.snapshotId).toBe(snapshotId);
            expect(skip?.openFindingIds).toEqual(["checkout-submit", "cart-empties"]);
            expect(skip?.reason).toBe("hotfix for prod outage");

            // The check is unblocked (neutral) on both GitHub and our store.
            expect(fixture.fakeClient.checkRuns[0]?.conclusion).toBe("neutral");
            const row = await harness.db.gitHubCheckRun.findUnique({
                where: { repoFullName_headSha: { repoFullName: fixture.repoFullName, headSha: "head-1" } },
            });
            expect(row?.conclusion).toBe("neutral");

            const skipEvents = analytics.captures.filter((c) => c.event === "merge_gate.skipped");
            expect(skipEvents).toHaveLength(1);
            expect(skipEvents[0]?.properties).toMatchObject({
                organizationId: harness.organizationId,
                repoFullName: fixture.repoFullName,
                prNumber: 42,
                headSha: "head-1",
                actorLogin: "dev-who-skipped",
                openBugCount: 2,
                snapshotId,
            });

            // A standalone PR comment makes the skip visible, attributing who + the open-bug count + the reason.
            const skipNotes = fixture.fakeClient.comments.filter((c) => c.body.includes("skipped the Autonoma check"));
            expect(skipNotes).toHaveLength(1);
            expect(skipNotes[0]?.prNumber).toBe(42);
            expect(skipNotes[0]?.body).toContain("@dev-who-skipped");
            expect(skipNotes[0]?.body).toContain("2 bugs were open");
            expect(skipNotes[0]?.body).toContain("skipped the Autonoma check because hotfix for prod outage");
            expect(skipNotes[0]?.body).toContain("SKIPPED");
            expect(skipNotes[0]?.body).toContain("autonoma:merge-gate-skip:v1");
            expect(skipNotes[0]?.body).not.toContain("autonoma:pr-comment:v2");
            expect(skip?.skipCommentId).toBe(skipNotes[0]?.id);
        });

        test("a repeated /autonoma-skip writes no duplicate record, event, or note", async ({ harness }) => {
            const analytics = new RecordingAnalytics();
            await setGate(harness, { analysisEnabled: true, mergeGateEnabled: true });
            const service = new MergeGateService(harness.db, harness.githubApp, true, analytics);
            const fixture = await createRepoApp(harness, "gate-skip-twice");
            await createSnapshotWithBugs(harness, fixture.appId, "head-1", ["only-bug"]);

            await service.postPending({ ...fixture.postParams });
            await setCheckConclusion(harness, fixture.repoFullName, "head-1", "failure");

            const payload = skipCommentPayload(fixture, "/autonoma-skip fixing later", "dev");
            await service.applySkipFromCommentWebhook(harness.organizationId, payload);
            await service.applySkipFromCommentWebhook(harness.organizationId, payload);

            const records = await harness.db.skipRecord.findMany({
                where: { repoFullName: fixture.repoFullName, headSha: "head-1" },
            });
            expect(records).toHaveLength(1);
            expect(records[0]?.reason).toBe("fixing later");
            expect(fixture.fakeClient.checkRuns[0]?.conclusion).toBe("neutral");
            expect(analytics.captures.filter((c) => c.event === "merge_gate.skipped")).toHaveLength(1);
            expect(
                fixture.fakeClient.comments.filter((c) => c.body.includes("skipped the Autonoma check")),
            ).toHaveLength(1);
        });

        test("a /autonoma-skip with no reason is rejected: no skip, and a reply asks for a reason", async ({
            harness,
        }) => {
            const analytics = new RecordingAnalytics();
            await setGate(harness, { analysisEnabled: true, mergeGateEnabled: true });
            const service = new MergeGateService(harness.db, harness.githubApp, true, analytics);
            const fixture = await createRepoApp(harness, "gate-skip-noreason");
            await createSnapshotWithBugs(harness, fixture.appId, "head-1", ["only-bug"]);

            await service.postPending({ ...fixture.postParams });
            await setCheckConclusion(harness, fixture.repoFullName, "head-1", "failure");

            // A bare command and a whitespace-only reason are both rejected.
            await service.applySkipFromCommentWebhook(
                harness.organizationId,
                skipCommentPayload(fixture, "/autonoma-skip", "dev"),
            );
            await service.applySkipFromCommentWebhook(
                harness.organizationId,
                skipCommentPayload(fixture, "/autonoma-skip    ", "dev"),
            );

            // Nothing was skipped: the check stays failing, no SkipRecord, no skip event, no attribution note.
            expect(await harness.db.skipRecord.findFirst({ where: { repoFullName: fixture.repoFullName } })).toBeNull();
            expect(fixture.fakeClient.checkRuns[0]?.conclusion).toBe("failure");
            expect(analytics.captures.filter((c) => c.event === "merge_gate.skipped")).toHaveLength(0);
            expect(
                fixture.fakeClient.comments.filter((c) => c.body.includes("skipped the Autonoma check")),
            ).toHaveLength(0);

            // Each invocation replies asking for a reason.
            const replies = fixture.fakeClient.comments.filter((c) => c.body.includes("please include a reason"));
            expect(replies).toHaveLength(2);
            expect(replies[0]?.prNumber).toBe(42);
            expect(replies[0]?.body).toContain("/autonoma-skip <why>");
        });

        test("applySkipFromCommentWebhook ignores non-command comments and comments on a passing check", async ({
            harness,
        }) => {
            const analytics = new RecordingAnalytics();
            await setGate(harness, { analysisEnabled: true, mergeGateEnabled: true });
            const service = new MergeGateService(harness.db, harness.githubApp, true, analytics);
            const fixture = await createRepoApp(harness, "gate-skip-ignored");
            await createSnapshotWithBugs(harness, fixture.appId, "head-1", ["bug-a"]);
            await service.postPending({ ...fixture.postParams });
            await setCheckConclusion(harness, fixture.repoFullName, "head-1", "failure");

            // A comment that is not the command: no skip.
            await service.applySkipFromCommentWebhook(
                harness.organizationId,
                skipCommentPayload(fixture, "lgtm, merging", "dev"),
            );
            // The command, but on a comment that GitHub marks as a plain issue (no pull_request): no skip.
            await service.applySkipFromCommentWebhook(harness.organizationId, {
                issue: { number: 42 },
                comment: { body: "/autonoma-skip", user: { login: "dev" } },
                repository: { id: fixture.repoId, full_name: fixture.repoFullName },
            });

            expect(await harness.db.skipRecord.findFirst({ where: { repoFullName: fixture.repoFullName } })).toBeNull();
            expect(fixture.fakeClient.checkRuns[0]?.conclusion).toBe("failure");

            // The command on a check that already passed (success): nothing to skip.
            await setCheckConclusion(harness, fixture.repoFullName, "head-1", "success");
            await service.applySkipFromCommentWebhook(
                harness.organizationId,
                skipCommentPayload(fixture, "/autonoma-skip not needed", "dev"),
            );
            expect(await harness.db.skipRecord.findFirst({ where: { repoFullName: fixture.repoFullName } })).toBeNull();
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

/** The worker sets the real conclusion at finalize; the tests stand in for it by writing the stored conclusion directly. */
async function setCheckConclusion(
    harness: APITestHarness,
    repoFullName: string,
    headSha: string,
    conclusion: string,
): Promise<void> {
    await harness.db.gitHubCheckRun.update({
        where: { repoFullName_headSha: { repoFullName, headSha } },
        data: { conclusion },
    });
}

/** A minimal `issue_comment.created` payload for a PR comment (the `pull_request` field marks it as a PR, not an issue). */
function skipCommentPayload(fixture: RepoAppFixture, body: string, login: string): Record<string, unknown> {
    return {
        issue: { number: fixture.postParams.prNumber, pull_request: { url: "https://api.github.com/pr/42" } },
        comment: { body, user: { login } },
        repository: { id: fixture.repoId, full_name: fixture.repoFullName },
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
    await harness.db.analysisJob.create({
        data: { snapshotId: snapshot.id, status: "completed", organizationId: harness.organizationId },
    });
    await harness.db.analysisReport.create({
        data: {
            snapshotId: snapshot.id,
            verdict: "client_bug",
            summary: "The run found client bugs.",
            reportMarkdown: "## Run\n\nClient bugs found.",
            organizationId: harness.organizationId,
        },
    });
    // Findings key to the AnalysisJob; create them directly against the shared snapshot id. Each FKs the
    // generation whose run produced its verdict.
    const generationFor = await seedFindingGenerations(harness.db, snapshot.id, findingKeys);
    await harness.db.analysisFinding.createMany({
        data: findingKeys.map((key, index) => ({
            reportSnapshotId: snapshot.id,
            findingKey: key,
            slug: key,
            generationId: generationFor(key),
            category: "client_bug",
            headline: `Bug ${key}`,
            displayOrder: index,
            organizationId: harness.organizationId,
        })),
    });
    return snapshot.id;
}
