import { PostHogAnalytics } from "@autonoma/analytics";
import { ApplicationArchitecture } from "@autonoma/db";
import type { ResolvedContributor } from "@autonoma/github";
import { expect } from "vitest";
import { BranchContributorService } from "../../src/github/branch-contributor.service";
import { BugFixOutcomeService } from "../../src/github/bug-fix-outcome.service";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";
import { seedAnalysisIssue } from "../seed-analysis-findings";

interface CapturedEvent {
    event: string;
    properties?: Record<string, unknown>;
}

/** Records capture() calls so we can assert the bug-fix events (and their absence) without PostHog. */
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

/** Returns a fixed author set for the fixing push so attribution can be asserted without a real GitHub call. */
class StubBranchContributor extends BranchContributorService {
    override async resolveFixingPushAuthors(): Promise<ResolvedContributor[]> {
        return [
            { login: "fixer-1", isOpener: false },
            { login: "fixer-2", isOpener: true },
            // An unresolved co-author (no linked login) must drop out of the attributed logins.
            { login: undefined, displayName: "Ada", email: "ada@example.com", isOpener: false },
        ];
    }
}

const MERGED_AT = new Date("2026-07-21T00:00:00Z");
const RESOLVED_AT = new Date("2026-07-20T00:00:00Z");
// A completed run's snapshot must predate the merge, so the pre-merge `isAssessed` bound (createdAt <= mergedAt)
// counts it. Kept at/before RESOLVED_AT so fix attribution resolves to it too.
const SNAPSHOT_CREATED_AT = new Date("2026-07-19T00:00:00Z");

apiTestSuite({
    name: "BugFixOutcomeService",
    cases: (test) => {
        test("a resolved bug records fixed_before_merge and emits bug.fixed", async ({ harness }) => {
            const analytics = new RecordingAnalytics();
            await setGate(harness, { analysisEnabled: true, mergeGateEnabled: true });
            const service = new BugFixOutcomeService(harness.db, analytics, true);
            const fixture = await createRepoApp(harness, "bfo-fixed");
            const branchId = await createTrackedPr(harness, fixture, { withCompletedRun: true });
            const issueId = await addBugIssue(harness, branchId, {
                resolved: true,
                severity: "high",
                resolvedAt: new Date("2026-07-20T00:00:00Z"),
            });

            await service.recordBugFixOutcomes(mergeParams(harness, fixture));

            const rows = await harness.db.bugFixOutcome.findMany({ where: { branchId } });
            expect(rows).toHaveLength(1);
            expect(rows[0]?.outcome).toBe("fixed_before_merge");
            expect(rows[0]?.issueId).toBe(issueId);
            expect(rows[0]?.severity).toBe("high");
            expect(rows[0]?.mergedByLogin).toBe("merger");
            expect(rows[0]?.mergedAt?.toISOString()).toBe(MERGED_AT.toISOString());

            const fixed = analytics.captures.filter((c) => c.event === "bug.fixed");
            expect(fixed).toHaveLength(1);
            expect(fixed[0]?.properties).toMatchObject({
                organizationId: harness.organizationId,
                repoFullName: fixture.repoFullName,
                prNumber: 42,
                branchId,
                issueId,
                severity: "high",
            });
            expect(analytics.captures.filter((c) => c.event === "bug.merged_open")).toHaveLength(0);
        });

        test("an open bug records merged_with_bug and emits bug.merged_open", async ({ harness }) => {
            const analytics = new RecordingAnalytics();
            await setGate(harness, { analysisEnabled: true, mergeGateEnabled: true });
            const service = new BugFixOutcomeService(harness.db, analytics, true);
            const fixture = await createRepoApp(harness, "bfo-open");
            const branchId = await createTrackedPr(harness, fixture, { withCompletedRun: true });
            const issueId = await addBugIssue(harness, branchId, { severity: "critical" });

            await service.recordBugFixOutcomes(mergeParams(harness, fixture));

            const rows = await harness.db.bugFixOutcome.findMany({ where: { branchId } });
            expect(rows).toHaveLength(1);
            expect(rows[0]?.outcome).toBe("merged_with_bug");
            expect(rows[0]?.issueId).toBe(issueId);
            expect(rows[0]?.severity).toBe("critical");

            const mergedOpen = analytics.captures.filter((c) => c.event === "bug.merged_open");
            expect(mergedOpen).toHaveLength(1);
            expect(mergedOpen[0]?.properties).toMatchObject({ issueId, branchId });
            expect(analytics.captures.filter((c) => c.event === "bug.fixed")).toHaveLength(0);
        });

        test("a mix of resolved and open bugs records one row per bug with the matching event", async ({ harness }) => {
            const analytics = new RecordingAnalytics();
            await setGate(harness, { analysisEnabled: true, mergeGateEnabled: true });
            const service = new BugFixOutcomeService(harness.db, analytics, true);
            const fixture = await createRepoApp(harness, "bfo-mix");
            const branchId = await createTrackedPr(harness, fixture, { withCompletedRun: true });
            const fixedId = await addBugIssue(harness, branchId, {
                resolved: true,
                severity: "medium",
                resolvedAt: new Date("2026-07-20T00:00:00Z"),
            });
            const openId = await addBugIssue(harness, branchId, { severity: "low" });
            // An environment issue is not a bug - it must be ignored entirely.
            await addIssue(harness, branchId, { kind: "environment", severity: "high" });

            await service.recordBugFixOutcomes(mergeParams(harness, fixture));

            const rows = await harness.db.bugFixOutcome.findMany({ where: { branchId }, orderBy: { severity: "asc" } });
            expect(rows).toHaveLength(2);
            const byIssue = new Map(rows.map((r) => [r.issueId, r.outcome]));
            expect(byIssue.get(fixedId)).toBe("fixed_before_merge");
            expect(byIssue.get(openId)).toBe("merged_with_bug");
            expect(analytics.captures.filter((c) => c.event === "bug.fixed")).toHaveLength(1);
            expect(analytics.captures.filter((c) => c.event === "bug.merged_open")).toHaveLength(1);
        });

        test("a skipped PR records skipped rows and emits no event", async ({ harness }) => {
            const analytics = new RecordingAnalytics();
            await setGate(harness, { analysisEnabled: true, mergeGateEnabled: true });
            const service = new BugFixOutcomeService(harness.db, analytics, true);
            const fixture = await createRepoApp(harness, "bfo-skip");
            const branchId = await createTrackedPr(harness, fixture, { withCompletedRun: true });
            await addBugIssue(harness, branchId, { severity: "high" });
            await addBugIssue(harness, branchId, {
                resolved: true,
                severity: "low",
                resolvedAt: new Date("2026-07-20T00:00:00Z"),
            });
            await harness.db.skipRecord.create({
                data: {
                    organizationId: harness.organizationId,
                    repoFullName: fixture.repoFullName,
                    prNumber: 42,
                    headSha: "head-1",
                    actorLogin: "dev",
                    openBugCount: 1,
                    openFindingIds: [],
                },
            });

            await service.recordBugFixOutcomes(mergeParams(harness, fixture));

            const rows = await harness.db.bugFixOutcome.findMany({ where: { branchId } });
            expect(rows).toHaveLength(2);
            expect(rows.every((r) => r.outcome === "skipped")).toBe(true);
            expect(analytics.captures).toHaveLength(0);
        });

        test("a PR with no completed analysis records a single unknown marker and emits no event", async ({
            harness,
        }) => {
            const analytics = new RecordingAnalytics();
            await setGate(harness, { analysisEnabled: true, mergeGateEnabled: true });
            const service = new BugFixOutcomeService(harness.db, analytics, true);
            const fixture = await createRepoApp(harness, "bfo-unknown");
            // No snapshot / no AnalysisReport: the analysis never assessed this PR.
            const branchId = await createTrackedPr(harness, fixture, { withCompletedRun: false });

            await service.recordBugFixOutcomes(mergeParams(harness, fixture));

            const rows = await harness.db.bugFixOutcome.findMany({ where: { branchId } });
            expect(rows).toHaveLength(1);
            expect(rows[0]?.outcome).toBe("unknown");
            expect(rows[0]?.issueId).toBeNull();
            expect(analytics.captures).toHaveLength(0);
        });

        test("a clean PR (analysis ran, no bugs) records no rows and emits no event", async ({ harness }) => {
            const analytics = new RecordingAnalytics();
            await setGate(harness, { analysisEnabled: true, mergeGateEnabled: true });
            const service = new BugFixOutcomeService(harness.db, analytics, true);
            const fixture = await createRepoApp(harness, "bfo-clean");
            const branchId = await createTrackedPr(harness, fixture, { withCompletedRun: true });

            await service.recordBugFixOutcomes(mergeParams(harness, fixture));

            expect(await harness.db.bugFixOutcome.findMany({ where: { branchId } })).toHaveLength(0);
            expect(analytics.captures).toHaveLength(0);
        });

        test("a redelivered close writes no duplicate rows and emits no duplicate events", async ({ harness }) => {
            const analytics = new RecordingAnalytics();
            await setGate(harness, { analysisEnabled: true, mergeGateEnabled: true });
            const service = new BugFixOutcomeService(harness.db, analytics, true);
            const fixture = await createRepoApp(harness, "bfo-redeliver");
            const branchId = await createTrackedPr(harness, fixture, { withCompletedRun: true });
            await addBugIssue(harness, branchId, {
                resolved: true,
                severity: "high",
                resolvedAt: new Date("2026-07-20T00:00:00Z"),
            });

            await service.recordBugFixOutcomes(mergeParams(harness, fixture));
            await service.recordBugFixOutcomes(mergeParams(harness, fixture));

            expect(await harness.db.bugFixOutcome.findMany({ where: { branchId } })).toHaveLength(1);
            expect(analytics.captures.filter((c) => c.event === "bug.fixed")).toHaveLength(1);
        });

        test("an unmerged close and a disabled org both record nothing", async ({ harness }) => {
            const analytics = new RecordingAnalytics();
            const fixture = await createRepoApp(harness, "bfo-gate");
            const branchId = await createTrackedPr(harness, fixture, { withCompletedRun: true });
            await addBugIssue(harness, branchId, { severity: "high" });

            // Merged but the org has not enabled the gate: nothing recorded.
            await setGate(harness, { analysisEnabled: true, mergeGateEnabled: false });
            await new BugFixOutcomeService(harness.db, analytics, true).recordBugFixOutcomes(
                mergeParams(harness, fixture),
            );
            expect(await harness.db.bugFixOutcome.findMany({ where: { branchId } })).toHaveLength(0);

            // Gate enabled but the PR closed without merging: nothing recorded.
            await setGate(harness, { analysisEnabled: true, mergeGateEnabled: true });
            await new BugFixOutcomeService(harness.db, analytics, true).recordBugFixOutcomes({
                ...mergeParams(harness, fixture),
                merged: false,
            });
            expect(await harness.db.bugFixOutcome.findMany({ where: { branchId } })).toHaveLength(0);
            expect(analytics.captures).toHaveLength(0);
        });

        test("a fix attributes the resolving push authors' logins on bug.fixed", async ({ harness }) => {
            const analytics = new RecordingAnalytics();
            await setGate(harness, { analysisEnabled: true, mergeGateEnabled: true });
            const contributor = new StubBranchContributor(harness.db, harness.services.github);
            const service = new BugFixOutcomeService(harness.db, analytics, true, contributor);
            const fixture = await createRepoApp(harness, "bfo-attrib");
            const branchId = await createTrackedPr(harness, fixture, { withCompletedRun: true });
            await addBugIssue(harness, branchId, { resolved: true, severity: "high", resolvedAt: RESOLVED_AT });

            await service.recordBugFixOutcomes(mergeParams(harness, fixture));

            const fixed = analytics.captures.filter((c) => c.event === "bug.fixed");
            expect(fixed).toHaveLength(1);
            // The two resolved logins ride the event; the unresolved co-author is dropped.
            expect(fixed[0]?.properties?.fixAuthorLogins).toEqual(["fixer-1", "fixer-2"]);
            const rows = await harness.db.bugFixOutcome.findMany({ where: { branchId } });
            expect(rows[0]?.outcome).toBe("fixed_before_merge");
        });

        test("a skip on a superseded head does not suppress a fix at the merged head", async ({ harness }) => {
            const analytics = new RecordingAnalytics();
            await setGate(harness, { analysisEnabled: true, mergeGateEnabled: true });
            const service = new BugFixOutcomeService(harness.db, analytics, true);
            const fixture = await createRepoApp(harness, "bfo-skip-superseded");
            const branchId = await createTrackedPr(harness, fixture, { withCompletedRun: true });
            const issueId = await addBugIssue(harness, branchId, {
                resolved: true,
                severity: "high",
                resolvedAt: RESOLVED_AT,
            });
            // The developer skipped at an EARLIER head, then pushed the fix; the PR merged at "head-1".
            await harness.db.skipRecord.create({
                data: {
                    organizationId: harness.organizationId,
                    repoFullName: fixture.repoFullName,
                    prNumber: 42,
                    headSha: "superseded-head",
                    actorLogin: "dev",
                    openBugCount: 1,
                    openFindingIds: [],
                },
            });

            await service.recordBugFixOutcomes(mergeParams(harness, fixture));

            const rows = await harness.db.bugFixOutcome.findMany({ where: { branchId } });
            expect(rows).toHaveLength(1);
            expect(rows[0]?.outcome).toBe("fixed_before_merge");
            expect(rows[0]?.issueId).toBe(issueId);
            expect(analytics.captures.filter((c) => c.event === "bug.fixed")).toHaveLength(1);
        });

        test("an unfinished final run after an earlier completed run records unknown (conservative)", async ({
            harness,
        }) => {
            const analytics = new RecordingAnalytics();
            await setGate(harness, { analysisEnabled: true, mergeGateEnabled: true });
            const service = new BugFixOutcomeService(harness.db, analytics, true);
            const fixture = await createRepoApp(harness, "bfo-stale");
            // The earlier push has a completed run; the final pre-merge push's run never produced a report.
            const branchId = await createTrackedPr(harness, fixture, { withCompletedRun: true });
            await harness.db.branchSnapshot.create({
                data: {
                    branchId,
                    source: "WEBHOOK",
                    status: "processing",
                    headSha: "head-2",
                    createdAt: new Date("2026-07-20T12:00:00Z"),
                },
            });
            await addBugIssue(harness, branchId, { resolved: true, severity: "high", resolvedAt: RESOLVED_AT });

            await service.recordBugFixOutcomes(mergeParams(harness, fixture));

            const rows = await harness.db.bugFixOutcome.findMany({ where: { branchId } });
            expect(rows).toHaveLength(1);
            expect(rows[0]?.outcome).toBe("unknown");
            expect(analytics.captures).toHaveLength(0);
        });

        test("a snapshot created after the merge does not flip an assessed PR to unknown", async ({ harness }) => {
            const analytics = new RecordingAnalytics();
            await setGate(harness, { analysisEnabled: true, mergeGateEnabled: true });
            const service = new BugFixOutcomeService(harness.db, analytics, true);
            const fixture = await createRepoApp(harness, "bfo-merge-commit");
            const branchId = await createTrackedPr(harness, fixture, { withCompletedRun: true });
            // A run whose snapshot was created for the merge commit itself (after mergedAt) must be ignored.
            await harness.db.branchSnapshot.create({
                data: {
                    branchId,
                    source: "WEBHOOK",
                    status: "processing",
                    headSha: "merge-commit",
                    createdAt: new Date("2026-07-25T00:00:00Z"),
                },
            });
            await addBugIssue(harness, branchId, { resolved: true, severity: "high", resolvedAt: RESOLVED_AT });

            await service.recordBugFixOutcomes(mergeParams(harness, fixture));

            const rows = await harness.db.bugFixOutcome.findMany({ where: { branchId } });
            expect(rows).toHaveLength(1);
            expect(rows[0]?.outcome).toBe("fixed_before_merge");
        });

        test("a redelivered unknown does not write a second marker row", async ({ harness }) => {
            const analytics = new RecordingAnalytics();
            await setGate(harness, { analysisEnabled: true, mergeGateEnabled: true });
            const service = new BugFixOutcomeService(harness.db, analytics, true);
            const fixture = await createRepoApp(harness, "bfo-unknown-redeliver");
            const branchId = await createTrackedPr(harness, fixture, { withCompletedRun: false });

            await service.recordBugFixOutcomes(mergeParams(harness, fixture));
            await service.recordBugFixOutcomes(mergeParams(harness, fixture));

            const rows = await harness.db.bugFixOutcome.findMany({ where: { branchId } });
            expect(rows).toHaveLength(1);
            expect(rows[0]?.outcome).toBe("unknown");
        });
    },
});

interface RepoAppFixture {
    appId: string;
    repoId: number;
    repoFullName: string;
}

/** Create a fresh repo + linked application per test so rows never collide on the shared integration DB. */
async function createRepoApp(harness: APITestHarness, seed: string): Promise<RepoAppFixture> {
    const repoId = Math.floor(Math.random() * 1_000_000) + 500_000;
    const repoFullName = `org/${seed}-${repoId}`;
    const app = await harness.services.applications.createApplication({
        name: `${seed}-${repoId}`,
        organizationId: harness.organizationId,
        architecture: ApplicationArchitecture.WEB,
        url: "https://example.com",
        file: "s3://bucket/file.png",
    });
    await harness.db.application.update({ where: { id: app.id }, data: { githubRepositoryId: repoId } });
    return { appId: app.id, repoId, repoFullName };
}

/**
 * A tracked feature branch for PR #42. With `withCompletedRun`, a snapshot carrying a completed AnalysisReport is
 * attached (so the branch reads as authoritatively assessed); without it, the branch has no finished run.
 */
async function createTrackedPr(
    harness: APITestHarness,
    fixture: RepoAppFixture,
    { withCompletedRun }: { withCompletedRun: boolean },
): Promise<string> {
    const branch = await harness.db.branch.create({
        data: {
            name: `feature/${crypto.randomUUID()}`,
            applicationId: fixture.appId,
            organizationId: harness.organizationId,
        },
    });
    await harness.db.featureBranchInfo.create({
        data: { branchId: branch.id, applicationId: fixture.appId, prNumber: 42, prState: "merged" },
    });
    if (withCompletedRun) {
        const snapshot = await harness.db.branchSnapshot.create({
            data: {
                branchId: branch.id,
                source: "WEBHOOK",
                status: "active",
                headSha: "head-1",
                createdAt: SNAPSHOT_CREATED_AT,
            },
        });
        await harness.db.analysisJob.create({
            data: { snapshotId: snapshot.id, status: "completed", organizationId: harness.organizationId },
        });
        await harness.db.analysisReport.create({
            data: {
                snapshotId: snapshot.id,
                title: "Autonoma checked this PR",
                headline: "Run complete.",
                reportMarkdown: "## Run",
                organizationId: harness.organizationId,
            },
        });
    }
    return branch.id;
}

async function addBugIssue(
    harness: APITestHarness,
    branchId: string,
    opts: { resolved?: boolean; severity: string; resolvedAt?: Date },
): Promise<string> {
    return addIssue(harness, branchId, { kind: "bug", ...opts });
}

async function addIssue(
    harness: APITestHarness,
    branchId: string,
    opts: { kind: string; resolved?: boolean; severity: string; resolvedAt?: Date },
): Promise<string> {
    return await seedAnalysisIssue(harness.db, {
        branchId,
        organizationId: harness.organizationId,
        title: `${opts.kind} issue`,
        kind: opts.kind,
        severity: opts.severity,
        resolved: opts.resolved,
        resolvedAt: opts.resolvedAt,
        actualBehavior: "It did the wrong thing.",
        narrativeMarkdown: "The narrative.",
    });
}

function mergeParams(harness: APITestHarness, fixture: RepoAppFixture) {
    return {
        organizationId: harness.organizationId,
        repoFullName: fixture.repoFullName,
        githubRepositoryId: fixture.repoId,
        prNumber: 42,
        headSha: "head-1",
        merged: true,
        mergedByLogin: "merger",
        mergedAt: MERGED_AT,
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
