import { PostHogAnalytics } from "@autonoma/analytics";
import { ApplicationArchitecture } from "@autonoma/db";
import { expect } from "vitest";
import type { AnalysisRunTrigger, RequestRunOutcome, RequestRunParams } from "../../src/github/analysis-run-trigger";
import { MergeGateService } from "../../src/github/merge-gate.service";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";
import { seedAnalysisFindings } from "../seed-analysis-findings";

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

/** Records the runs requested through the trigger so we can assert exactly one run was fired (and with what). */
class RecordingRunTrigger implements AnalysisRunTrigger {
    public calls: RequestRunParams[] = [];
    constructor(private readonly outcome: RequestRunOutcome = { started: true }) {}

    async requestRun(params: RequestRunParams): Promise<RequestRunOutcome> {
        this.calls.push(params);
        return this.outcome;
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
            await setGate(harness, false);
            const disabled = new MergeGateService(
                harness.db,
                harness.githubApp,
                true,
                analytics,
                harness.services.falsePositiveCandidates,
            );
            await disabled.postPending({ ...fixture.postParams });
            expect(checkRunsFor(fixture)).toHaveLength(0);
            expect(
                await harness.db.gitHubCheckRun.findUnique({
                    where: { repoFullName_headSha: { repoFullName: fixture.repoFullName, headSha: "head-1" } },
                }),
            ).toBeNull();

            // Enabled org: an in-progress check is posted and persisted, idempotently per head.
            await setGate(harness, true);
            const enabled = new MergeGateService(
                harness.db,
                harness.githubApp,
                true,
                analytics,
                harness.services.falsePositiveCandidates,
            );
            await enabled.postPending({ ...fixture.postParams });
            await enabled.postPending({ ...fixture.postParams });

            expect(checkRunsFor(fixture)).toHaveLength(1);
            expect(checkRunsFor(fixture)[0]?.status).toBe("in_progress");
            const row = await harness.db.gitHubCheckRun.findUnique({
                where: { repoFullName_headSha: { repoFullName: fixture.repoFullName, headSha: "head-1" } },
            });
            expect(row?.prNumber).toBe(42);
        });

        test("an activation-migrated org gets a completed neutral 'no analysis requested' check and no run", async ({
            harness,
        }) => {
            const analytics = new RecordingAnalytics();
            const trigger = new RecordingRunTrigger();
            await setGate(harness, true, true);
            const service = new MergeGateService(
                harness.db,
                harness.githubApp,
                true,
                analytics,
                harness.services.falsePositiveCandidates,
                undefined,
                trigger,
            );
            const fixture = await createRepoApp(harness, "gate-unrequested");

            await service.postPending({ ...fixture.postParams });

            // The check is a COMPLETED neutral state (mergeable even when required), not a hanging in_progress.
            const run = checkRunsFor(fixture)[0];
            expect(run?.status).toBe("completed");
            expect(run?.conclusion).toBe("neutral");
            expect(run?.title).toContain("No analysis requested");
            expect(run?.summary).toContain("/start analysis");
            expect(await storedConclusion(harness, fixture)).toBe("neutral");

            // Nothing ran on its own, and no activation was recorded.
            expect(trigger.calls).toHaveLength(0);
            const row = await harness.db.gitHubCheckRun.findUnique({
                where: { repoFullName_headSha: { repoFullName: fixture.repoFullName, headSha: "head-1" } },
            });
            expect(row?.activationSource).toBeNull();
            expect(row?.activatedByLogin).toBeNull();
        });

        test("a /start analysis comment from a write-access user fires one run, flips the check, and records the activation", async ({
            harness,
        }) => {
            const analytics = new RecordingAnalytics();
            const trigger = new RecordingRunTrigger();
            await setGate(harness, true, true);
            const service = new MergeGateService(
                harness.db,
                harness.githubApp,
                true,
                analytics,
                harness.services.falsePositiveCandidates,
                undefined,
                trigger,
            );
            const fixture = await createRepoApp(harness, "gate-start");
            fixture.fakeClient.addPullRequest(fixture.repoFullName, {
                number: 42,
                title: "Add checkout",
                headRef: "feature/start",
                baseSha: "base-1",
                commits: ["head-1"],
            });
            fixture.fakeClient.setCollaboratorPermission(fixture.repoFullName, "dev-writer", "write");

            await service.postPending({ ...fixture.postParams });
            await service.requestStartFromCommentWebhook(
                harness.organizationId,
                skipCommentPayload(fixture, "/start analysis", "dev-writer"),
            );

            // Exactly one run was requested, for this PR.
            expect(trigger.calls).toHaveLength(1);
            expect(trigger.calls[0]).toMatchObject({
                organizationId: harness.organizationId,
                repoFullName: fixture.repoFullName,
                githubRepositoryId: fixture.repoId,
                prNumber: 42,
            });

            // The check flipped from the neutral un-requested state to in-progress.
            expect(checkRunsFor(fixture)[0]?.status).toBe("in_progress");
            expect(await storedConclusion(harness, fixture)).toBe("in_progress");

            // The activation (source + actor) is recorded on the check row.
            const row = await harness.db.gitHubCheckRun.findUnique({
                where: { repoFullName_headSha: { repoFullName: fixture.repoFullName, headSha: "head-1" } },
            });
            expect(row?.activationSource).toBe("comment");
            expect(row?.activatedByLogin).toBe("dev-writer");
            expect(row?.activatedAt).not.toBeNull();

            const activated = analytics.captures.filter((c) => c.event === "merge_gate.activated");
            expect(activated).toHaveLength(1);
            expect(activated[0]?.properties).toMatchObject({
                organizationId: harness.organizationId,
                repoFullName: fixture.repoFullName,
                prNumber: 42,
                headSha: "head-1",
                source: "comment",
                actorLogin: "dev-writer",
            });
        });

        test("a /start analysis comment from a non-write-access user fires no run and leaves the check unchanged", async ({
            harness,
        }) => {
            const analytics = new RecordingAnalytics();
            const trigger = new RecordingRunTrigger();
            await setGate(harness, true, true);
            const service = new MergeGateService(
                harness.db,
                harness.githubApp,
                true,
                analytics,
                harness.services.falsePositiveCandidates,
                undefined,
                trigger,
            );
            const fixture = await createRepoApp(harness, "gate-start-unauth");
            fixture.fakeClient.addPullRequest(fixture.repoFullName, {
                number: 42,
                title: "Add checkout",
                headRef: "feature/unauth",
                baseSha: "base-1",
                commits: ["head-1"],
            });
            // "read-only-user" has no entry, so the fake reports "none" - not write access.

            await service.postPending({ ...fixture.postParams });
            await service.requestStartFromCommentWebhook(
                harness.organizationId,
                skipCommentPayload(fixture, "/start analysis", "read-only-user"),
            );

            expect(trigger.calls).toHaveLength(0);
            // The check stays the un-requested completed neutral state; no activation, no event.
            expect(checkRunsFor(fixture)[0]?.status).toBe("completed");
            expect(await storedConclusion(harness, fixture)).toBe("neutral");
            expect(analytics.captures.filter((c) => c.event === "merge_gate.activated")).toHaveLength(0);
            const row = await harness.db.gitHubCheckRun.findUnique({
                where: { repoFullName_headSha: { repoFullName: fixture.repoFullName, headSha: "head-1" } },
            });
            expect(row?.activationSource).toBeNull();
        });

        test("a /start analysis comment on a non-migrated org is ignored (it still runs automatically)", async ({
            harness,
        }) => {
            const analytics = new RecordingAnalytics();
            const trigger = new RecordingRunTrigger();
            // Gate enabled but NOT migrated to activation - the automatic run still fires on preview-ready.
            await setGate(harness, true, false);
            const service = new MergeGateService(
                harness.db,
                harness.githubApp,
                true,
                analytics,
                harness.services.falsePositiveCandidates,
                undefined,
                trigger,
            );
            const fixture = await createRepoApp(harness, "gate-start-nonmigrated");
            fixture.fakeClient.addPullRequest(fixture.repoFullName, {
                number: 42,
                title: "Add checkout",
                headRef: "feature/nonmigrated",
                baseSha: "base-1",
                commits: ["head-1"],
            });
            fixture.fakeClient.setCollaboratorPermission(fixture.repoFullName, "dev-writer", "write");

            await service.postPending({ ...fixture.postParams });
            await service.requestStartFromCommentWebhook(
                harness.organizationId,
                skipCommentPayload(fixture, "/start analysis", "dev-writer"),
            );

            // No manual run: the non-migrated org's automatic run is authoritative, so /start analysis is a no-op.
            expect(trigger.calls).toHaveLength(0);
            // The check keeps the non-migrated in-progress state postPending posted; no activation, no event.
            expect(checkRunsFor(fixture)[0]?.status).toBe("in_progress");
            expect(analytics.captures.filter((c) => c.event === "merge_gate.activated")).toHaveLength(0);
            const row = await harness.db.gitHubCheckRun.findUnique({
                where: { repoFullName_headSha: { repoFullName: fixture.repoFullName, headSha: "head-1" } },
            });
            expect(row?.activationSource).toBeNull();
        });

        test("a /start analysis whose run cannot start restores the un-requested check and replies", async ({
            harness,
        }) => {
            const analytics = new RecordingAnalytics();
            // The trigger reports it could not start a run (no live preview for the PR).
            const trigger = new RecordingRunTrigger({ started: false, reason: "no_preview" });
            await setGate(harness, true, true);
            const service = new MergeGateService(
                harness.db,
                harness.githubApp,
                true,
                analytics,
                harness.services.falsePositiveCandidates,
                undefined,
                trigger,
            );
            const fixture = await createRepoApp(harness, "gate-start-nopreview");
            fixture.fakeClient.addPullRequest(fixture.repoFullName, {
                number: 42,
                title: "Add checkout",
                headRef: "feature/nopreview",
                baseSha: "base-1",
                commits: ["head-1"],
            });
            fixture.fakeClient.setCollaboratorPermission(fixture.repoFullName, "dev-writer", "write");

            await service.postPending({ ...fixture.postParams });
            await service.requestStartFromCommentWebhook(
                harness.organizationId,
                skipCommentPayload(fixture, "/start analysis", "dev-writer"),
            );

            // The run was attempted, but since none started the check is restored to the un-requested neutral state.
            expect(trigger.calls).toHaveLength(1);
            expect(checkRunsFor(fixture)[0]?.status).toBe("completed");
            expect(await storedConclusion(harness, fixture)).toBe("neutral");
            expect(analytics.captures.filter((c) => c.event === "merge_gate.activated")).toHaveLength(0);
            // No activation is recorded when no run started.
            const row = await harness.db.gitHubCheckRun.findUnique({
                where: { repoFullName_headSha: { repoFullName: fixture.repoFullName, headSha: "head-1" } },
            });
            expect(row?.activationSource).toBeNull();
            // The requester is told why nothing ran.
            const replies = fixture.fakeClient.comments.filter(
                (comment) => comment.repoFullName === fixture.repoFullName && comment.body.includes("no live preview"),
            );
            expect(replies).toHaveLength(1);
        });

        test("a /autonoma-skip comment records the open bugs + reason and flips the check to neutral", async ({
            harness,
        }) => {
            const analytics = new RecordingAnalytics();
            await setGate(harness, true);
            const service = new MergeGateService(
                harness.db,
                harness.githubApp,
                true,
                analytics,
                harness.services.falsePositiveCandidates,
            );
            const fixture = await createRepoApp(harness, "gate-skip");

            // A snapshot at the PR head with a client_bug report (two open bugs).
            const snapshotId = await createSnapshotWithBugs(harness, fixture.appId, "head-1", [
                "checkout-submit",
                "cart-empties",
            ]);

            // Post the pending check, then simulate the worker having set it to failure.
            await service.postPending({ ...fixture.postParams });
            await setCheckConclusion(harness, fixture, "head-1", "failure");

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
            const bugFindingIds = await harness.db.analysisFinding.findMany({
                where: { reportSnapshotId: snapshotId },
                select: { id: true },
            });
            expect(new Set(skip?.openFindingIds)).toEqual(new Set(bugFindingIds.map((finding) => finding.id)));
            expect(skip?.reason).toBe("hotfix for prod outage");

            // The check is unblocked (neutral) on both GitHub and our store.
            expect(checkRunsFor(fixture)[0]?.conclusion).toBe("neutral");
            expect(await storedConclusion(harness, fixture)).toBe("neutral");

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
            const skipNotes = skipNotesFor(fixture);
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
            await setGate(harness, true);
            const service = new MergeGateService(
                harness.db,
                harness.githubApp,
                true,
                analytics,
                harness.services.falsePositiveCandidates,
            );
            const fixture = await createRepoApp(harness, "gate-skip-twice");
            await createSnapshotWithBugs(harness, fixture.appId, "head-1", ["only-bug"]);

            await service.postPending({ ...fixture.postParams });
            await setCheckConclusion(harness, fixture, "head-1", "failure");

            const payload = skipCommentPayload(fixture, "/autonoma-skip fixing later", "dev");
            await service.applySkipFromCommentWebhook(harness.organizationId, payload);
            await service.applySkipFromCommentWebhook(harness.organizationId, payload);

            const records = await harness.db.skipRecord.findMany({
                where: { repoFullName: fixture.repoFullName, headSha: "head-1" },
            });
            expect(records).toHaveLength(1);
            expect(records[0]?.reason).toBe("fixing later");
            expect(await storedConclusion(harness, fixture)).toBe("neutral");
            expect(analytics.captures.filter((c) => c.event === "merge_gate.skipped")).toHaveLength(1);
            expect(skipNotesFor(fixture)).toHaveLength(1);
        });

        test("a /autonoma-skip whose reason claims a false positive records skip_reason FP candidates AND skips normally", async ({
            harness,
        }) => {
            const analytics = new RecordingAnalytics();
            await setGate(harness, true);
            const service = new MergeGateService(
                harness.db,
                harness.githubApp,
                true,
                analytics,
                harness.services.falsePositiveCandidates,
            );
            const fixture = await createRepoApp(harness, "gate-skip-fp");
            const snapshotId = await createSnapshotWithBugs(harness, fixture.appId, "head-1", ["checkout", "cart"]);

            await service.postPending({ ...fixture.postParams });
            await setCheckConclusion(harness, fixture, "head-1", "failure");

            await service.applySkipFromCommentWebhook(
                harness.organizationId,
                skipCommentPayload(fixture, "/autonoma-skip this is a false positive, checkout works fine", "dev-fp"),
            );

            // The skip itself is unaffected: recorded, unblocked, alerted.
            const skip = await harness.db.skipRecord.findFirst({
                where: { repoFullName: fixture.repoFullName, headSha: "head-1" },
            });
            expect(skip?.openBugCount).toBe(2);
            expect(await storedConclusion(harness, fixture)).toBe("neutral");
            expect(analytics.captures.filter((c) => c.event === "merge_gate.skipped")).toHaveLength(1);

            // One FP candidate per open finding, keyed to the skip's snapshot, sourced from the skip reason.
            const candidates = await harness.db.findingFalsePositiveCandidate.findMany({
                where: { repoFullName: fixture.repoFullName, prNumber: 42 },
                orderBy: { findingKey: "asc" },
            });
            expect(candidates).toHaveLength(2);
            expect(candidates.map((c) => c.findingKey)).toEqual(["cart", "checkout"]);
            for (const candidate of candidates) {
                expect(candidate.source).toBe("skip_reason");
                expect(candidate.snapshotId).toBe(snapshotId);
                expect(candidate.reportedBy).toBe("dev-fp");
                expect(candidate.reason).toBe("this is a false positive, checkout works fine");
                expect(candidate.organizationId).toBe(harness.organizationId);
            }
        });

        test("a repeated FP-claiming /autonoma-skip does not duplicate FP candidates", async ({ harness }) => {
            const analytics = new RecordingAnalytics();
            await setGate(harness, true);
            const service = new MergeGateService(
                harness.db,
                harness.githubApp,
                true,
                analytics,
                harness.services.falsePositiveCandidates,
            );
            const fixture = await createRepoApp(harness, "gate-skip-fp-twice");
            await createSnapshotWithBugs(harness, fixture.appId, "head-1", ["checkout", "cart"]);

            await service.postPending({ ...fixture.postParams });
            await setCheckConclusion(harness, fixture, "head-1", "failure");

            const payload = skipCommentPayload(fixture, "/autonoma-skip false positive, checkout works", "dev-fp");
            await service.applySkipFromCommentWebhook(harness.organizationId, payload);
            await service.applySkipFromCommentWebhook(harness.organizationId, payload);

            // The FP capture runs only on the first skip (after the already-recorded early return), so the second
            // skip re-flips the check but adds no rows.
            expect(
                await harness.db.findingFalsePositiveCandidate.findMany({
                    where: { repoFullName: fixture.repoFullName },
                }),
            ).toHaveLength(2);
            expect(analytics.captures.filter((c) => c.event === "merge_gate.skipped")).toHaveLength(1);
        });

        test("a /autonoma-skip whose reason is not an FP claim records no FP candidate but still skips", async ({
            harness,
        }) => {
            const analytics = new RecordingAnalytics();
            await setGate(harness, true);
            const service = new MergeGateService(
                harness.db,
                harness.githubApp,
                true,
                analytics,
                harness.services.falsePositiveCandidates,
            );
            const fixture = await createRepoApp(harness, "gate-skip-nonfp");
            await createSnapshotWithBugs(harness, fixture.appId, "head-1", ["only-bug"]);

            await service.postPending({ ...fixture.postParams });
            await setCheckConclusion(harness, fixture, "head-1", "failure");

            await service.applySkipFromCommentWebhook(
                harness.organizationId,
                skipCommentPayload(fixture, "/autonoma-skip urgent hotfix, will fix in a follow-up", "dev"),
            );

            // Normal skip.
            expect(
                await harness.db.skipRecord.findFirst({ where: { repoFullName: fixture.repoFullName } }),
            ).not.toBeNull();
            expect(await storedConclusion(harness, fixture)).toBe("neutral");
            // No FP candidate: not every skip is a false positive.
            expect(
                await harness.db.findingFalsePositiveCandidate.findMany({
                    where: { repoFullName: fixture.repoFullName },
                }),
            ).toHaveLength(0);
        });

        test("a /autonoma-skip with no reason is rejected: no skip, and a reply asks for a reason", async ({
            harness,
        }) => {
            const analytics = new RecordingAnalytics();
            await setGate(harness, true);
            const service = new MergeGateService(
                harness.db,
                harness.githubApp,
                true,
                analytics,
                harness.services.falsePositiveCandidates,
            );
            const fixture = await createRepoApp(harness, "gate-skip-noreason");
            await createSnapshotWithBugs(harness, fixture.appId, "head-1", ["only-bug"]);

            await service.postPending({ ...fixture.postParams });
            await setCheckConclusion(harness, fixture, "head-1", "failure");

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
            expect(await storedConclusion(harness, fixture)).toBe("failure");
            expect(analytics.captures.filter((c) => c.event === "merge_gate.skipped")).toHaveLength(0);
            expect(skipNotesFor(fixture)).toHaveLength(0);

            // Each invocation replies asking for a reason.
            const replies = fixture.fakeClient.comments.filter(
                (c) => c.repoFullName === fixture.repoFullName && c.body.includes("please include a reason"),
            );
            expect(replies).toHaveLength(2);
            expect(replies[0]?.prNumber).toBe(42);
            expect(replies[0]?.body).toContain("/autonoma-skip <why>");
        });

        // The self-heal regression: a test whose FIRST classification was a client bug, rewritten and re-run to a
        // pass, must not read as an open bug. The run does not stand behind the superseded verdict, so gating a
        // merge on it would block a PR over a test we ourselves corrected.
        test("a client_bug verdict the run superseded is not counted as an open bug", async ({ harness }) => {
            const analytics = new RecordingAnalytics();
            await setGate(harness, true);
            const service = new MergeGateService(
                harness.db,
                harness.githubApp,
                true,
                analytics,
                harness.services.falsePositiveCandidates,
            );
            const fixture = await createRepoApp(harness, "gate-superseded");

            const branch = await harness.db.branch.create({
                data: {
                    name: `feature/superseded-${crypto.randomUUID()}`,
                    applicationId: fixture.appId,
                    organizationId: harness.organizationId,
                },
            });
            const snapshot = await harness.db.branchSnapshot.create({
                data: { branchId: branch.id, source: "WEBHOOK", status: "active", headSha: "head-1" },
            });
            await harness.db.analysisJob.create({
                data: { snapshotId: snapshot.id, status: "completed", organizationId: harness.organizationId },
            });
            await harness.db.analysisReport.create({
                data: {
                    snapshotId: snapshot.id,
                    verdict: "passed",
                    summary: "The run found no client bugs.",
                    reportMarkdown: "## Run\n\nNo client bugs.",
                    organizationId: harness.organizationId,
                },
            });
            await seedAnalysisFindings(harness.db, snapshot.id, [
                {
                    slug: "cart-badge",
                    category: "passed",
                    headline: "The badge is correct after the rewrite",
                    superseded: [{ category: "client_bug", headline: "The badge shows the old count" }],
                },
            ]);

            await service.postPending({ ...fixture.postParams });
            await setCheckConclusion(harness, fixture, "head-1", "failure");
            await service.applySkipFromCommentWebhook(
                harness.organizationId,
                skipCommentPayload(fixture, "/autonoma-skip nothing is actually open", "dev"),
            );

            const skip = await harness.db.skipRecord.findFirst({
                where: { repoFullName: fixture.repoFullName, headSha: "head-1" },
            });
            expect(skip?.openBugCount).toBe(0);
            expect(skip?.openFindingIds).toEqual([]);
        });

        test("applySkipFromCommentWebhook ignores non-command comments and comments on a passing check", async ({
            harness,
        }) => {
            const analytics = new RecordingAnalytics();
            await setGate(harness, true);
            const service = new MergeGateService(
                harness.db,
                harness.githubApp,
                true,
                analytics,
                harness.services.falsePositiveCandidates,
            );
            const fixture = await createRepoApp(harness, "gate-skip-ignored");
            await createSnapshotWithBugs(harness, fixture.appId, "head-1", ["bug-a"]);
            await service.postPending({ ...fixture.postParams });
            await setCheckConclusion(harness, fixture, "head-1", "failure");

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
            expect(await storedConclusion(harness, fixture)).toBe("failure");

            // The command on a check that already passed (success): nothing to skip.
            await setCheckConclusion(harness, fixture, "head-1", "success");
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
            await setGate(harness, true);
            const service = new MergeGateService(
                harness.db,
                harness.githubApp,
                true,
                analytics,
                harness.services.falsePositiveCandidates,
            );
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

        test("enableForOrg registers branch protection; disable de-registers it", async ({ harness }) => {
            const analytics = new RecordingAnalytics();
            const service = new MergeGateService(
                harness.db,
                harness.githubApp,
                true,
                analytics,
                harness.services.falsePositiveCandidates,
            );
            const fixture = await createRepoApp(harness, "gate-enable");

            // Enabling flips the flag and requires `Autonoma` on all branches (via ruleset).
            await setGate(harness, false);
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

/**
 * Land a terminal conclusion on the PR's check, as the analysis worker does: on GitHub AND in our own store. The
 * gate reads its store to decide whether there is anything to skip; the assertions read the client to see what a
 * reviewer would.
 */
async function setCheckConclusion(
    harness: APITestHarness,
    fixture: RepoAppFixture,
    headSha: string,
    conclusion: string,
): Promise<void> {
    const stored = await harness.db.gitHubCheckRun.update({
        where: { repoFullName_headSha: { repoFullName: fixture.repoFullName, headSha } },
        data: { conclusion },
    });
    await fixture.fakeClient.updateCheckRun({
        repoFullName: fixture.repoFullName,
        checkRunId: stored.checkRunId,
        status: "completed",
        conclusion,
        title: "Autonoma merge gate",
        summary: "",
    });
}

// The suite builds its harness (and its one fake GitHub client) once in beforeAll, so that client's `checkRuns`
// and `comments` accumulate across every test. These helpers scope an inspection to the fixture's own repo (each
// test uses a fresh random repoFullName) so a test never sees another's records.
function checkRunsFor(fixture: RepoAppFixture) {
    return fixture.fakeClient.checkRuns.filter((run) => run.repoFullName === fixture.repoFullName);
}

function skipNotesFor(fixture: RepoAppFixture) {
    return fixture.fakeClient.comments.filter(
        (comment) =>
            comment.repoFullName === fixture.repoFullName && comment.body.includes("skipped the Autonoma check"),
    );
}

/**
 * The stored `Autonoma` check conclusion for a head - the source of truth for whether it is blocking, unblocked, or
 * skipped. The check's conclusion lives on the DB row (written by the worker's finalize, the skip's setConclusion,
 * and setCheckConclusion in these tests), NOT on the fake GitHub client, whose created check stays `in_progress`
 * until an updateCheckRun call flips it.
 */
async function storedConclusion(
    harness: APITestHarness,
    fixture: RepoAppFixture,
    headSha = "head-1",
): Promise<string | null | undefined> {
    const row = await harness.db.gitHubCheckRun.findUnique({
        where: { repoFullName_headSha: { repoFullName: fixture.repoFullName, headSha } },
    });
    return row?.conclusion;
}

/** A minimal `issue_comment.created` payload for a PR comment (the `pull_request` field marks it as a PR, not an issue). */
function skipCommentPayload(fixture: RepoAppFixture, body: string, login: string): Record<string, unknown> {
    return {
        issue: { number: fixture.postParams.prNumber, pull_request: { url: "https://api.github.com/pr/42" } },
        comment: { body, user: { login } },
        repository: { id: fixture.repoId, full_name: fixture.repoFullName },
    };
}

async function setGate(harness: APITestHarness, mergeGateEnabled: boolean, activationEnabled = false): Promise<void> {
    const data = { mergeGateEnabled, activationEnabled };
    await harness.db.organizationSettings.upsert({
        where: { organizationId: harness.organizationId },
        create: { organizationId: harness.organizationId, ...data },
        update: data,
    });
}

/** A feature-branch snapshot at `headSha` with a client_bug report carrying a bug finding per given slug. */
async function createSnapshotWithBugs(
    harness: APITestHarness,
    applicationId: string,
    headSha: string,
    bugSlugs: string[],
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
    // Findings key to the AnalysisJob; create them directly against the shared snapshot id. Each verdict FKs the
    // generation whose run produced it.
    await seedAnalysisFindings(
        harness.db,
        snapshot.id,
        bugSlugs.map((slug) => ({ slug, category: "client_bug", headline: `Bug ${slug}` })),
    );
    return snapshot.id;
}
