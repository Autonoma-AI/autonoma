import { randomBytes } from "node:crypto";
import { PostHogAnalytics } from "@autonoma/analytics";
import { ApplicationArchitecture } from "@autonoma/db";
import { expect } from "vitest";
import { DEFAULT_ANALYSIS_TRIGGER_LABEL } from "../../src/github/activation-trigger-config";
import { ActivationTriggerConfigService } from "../../src/github/activation-trigger-config.service";
import type { AnalysisRunTrigger, RequestRunOutcome, RequestRunParams } from "../../src/github/analysis-run-trigger";
import { MergeGateService } from "../../src/github/merge-gate.service";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";

interface CapturedEvent {
    event: string;
    properties?: Record<string, unknown>;
}

/** Records capture() calls so we can assert the merge-gate events without a live PostHog. */
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

const HEAD_SHA = "head-1";
const PR_NUMBER = 42;

apiTestSuite({
    name: "activation trigger config",
    seed: async ({ harness }) => {
        // getApplicationRepository resolves the org's installation client; the fake app returns its defaultClient for
        // any id. installation_id is globally unique across the shared DB, so keep it random. 3 bytes stays in int4.
        await harness.services.github.handleInstallation(
            9_000_000 + randomBytes(3).readUIntBE(0, 3),
            harness.organizationId,
            "test-org",
            999,
            "Organization",
        );
        return {};
    },
    cases: (test) => {
        test("getForApplication returns the code defaults and repo name for an unconfigured repo", async ({
            harness,
        }) => {
            const service = new ActivationTriggerConfigService(harness.db, harness.services.github);
            const fixture = await createRepoApp(harness);

            const config = await service.getForApplication(harness.organizationId, fixture.appId);

            expect(config).toEqual({
                autoRunOnReadyForReview: false,
                analysisTriggerLabel: DEFAULT_ANALYSIS_TRIGGER_LABEL,
                repoFullName: fixture.repoFullName,
            });
        });

        test("updateForApplication upserts the config and getForApplication reads it back", async ({ harness }) => {
            const service = new ActivationTriggerConfigService(harness.db, harness.services.github);
            const fixture = await createRepoApp(harness);

            const saved = await service.updateForApplication(harness.organizationId, fixture.appId, {
                autoRunOnReadyForReview: true,
                analysisTriggerLabel: "team:review",
            });
            expect(saved).toEqual({ autoRunOnReadyForReview: true, analysisTriggerLabel: "team:review" });

            // The persisted row is what a later read (and every webhook trigger) resolves.
            const reread = await service.getForApplication(harness.organizationId, fixture.appId);
            expect(reread).toEqual({
                autoRunOnReadyForReview: true,
                analysisTriggerLabel: "team:review",
                repoFullName: fixture.repoFullName,
            });

            // A second update overwrites in place (upsert), it does not create a second row.
            await service.updateForApplication(harness.organizationId, fixture.appId, {
                autoRunOnReadyForReview: false,
                analysisTriggerLabel: "autonoma:analyze",
            });
            const rows = await harness.db.applicationTriggerConfig.findMany({
                where: { applicationId: fixture.appId },
            });
            expect(rows).toHaveLength(1);
            expect(rows[0]?.autoRunOnReadyForReview).toBe(false);
            expect(rows[0]?.analysisTriggerLabel).toBe("autonoma:analyze");
        });

        test("getForApplication rejects an application the org does not own", async ({ harness }) => {
            const service = new ActivationTriggerConfigService(harness.db, harness.services.github);
            const fixture = await createRepoApp(harness);

            // A caller whose active org is not the owner cannot read another org's app config.
            await expect(service.getForApplication("org-that-does-not-own-it", fixture.appId)).rejects.toThrow();
        });

        test("updateForApplication rejects an application the org does not own", async ({ harness }) => {
            const service = new ActivationTriggerConfigService(harness.db, harness.services.github);
            const fixture = await createRepoApp(harness);

            await expect(
                service.updateForApplication("org-that-does-not-own-it", fixture.appId, {
                    autoRunOnReadyForReview: true,
                    analysisTriggerLabel: "autonoma:analyze",
                }),
            ).rejects.toThrow();

            // Nothing was written for the app under the real org.
            const rows = await harness.db.applicationTriggerConfig.findMany({
                where: { applicationId: fixture.appId },
            });
            expect(rows).toHaveLength(0);
        });

        test("requestAnalysisRunFromApplication resolves the PR head and fires a ui-sourced run", async ({
            harness,
        }) => {
            const analytics = new RecordingAnalytics();
            const trigger = new RecordingRunTrigger({ started: true });
            const fixture = await createRepoApp(harness);
            await setActivationGate(harness);

            const mergeGate = new MergeGateService(
                harness.db,
                harness.githubApp,
                true,
                analytics,
                harness.services.falsePositiveCandidates,
                undefined,
                trigger,
            );

            const result = await mergeGate.requestAnalysisRunFromApplication({
                organizationId: harness.organizationId,
                applicationId: fixture.appId,
                prNumber: PR_NUMBER,
            });

            // The caller learns a run actually began (so the UI can show "started", not a blanket "requested").
            expect(result).toEqual({ status: "started" });

            // Exactly one run was fired for this PR, with the head resolved server-side.
            expect(trigger.calls).toHaveLength(1);
            expect(trigger.calls[0]).toMatchObject({
                organizationId: harness.organizationId,
                repoFullName: fixture.repoFullName,
                githubRepositoryId: fixture.repoId,
                prNumber: PR_NUMBER,
            });

            // The activation is persisted on the check row for the resolved head, sourced to the UI.
            const row = await harness.db.gitHubCheckRun.findUnique({
                where: { repoFullName_headSha: { repoFullName: fixture.repoFullName, headSha: HEAD_SHA } },
            });
            expect(row?.conclusion).toBe("in_progress");
            expect(row?.activationSource).toBe("ui");

            const activated = analytics.captures.filter((capture) => capture.event === "merge_gate.activated");
            expect(activated).toHaveLength(1);
            expect(activated[0]?.properties).toMatchObject({
                repoFullName: fixture.repoFullName,
                prNumber: PR_NUMBER,
                headSha: HEAD_SHA,
                source: "ui",
            });
        });

        test("requestAnalysisRunFromApplication no-ops without throwing when activation is off", async ({
            harness,
        }) => {
            const analytics = new RecordingAnalytics();
            const trigger = new RecordingRunTrigger({ started: true });
            const fixture = await createRepoApp(harness);
            // Gate enabled but activation off: an un-migrated org still runs automatically, so a request is a no-op.
            await setActivationGate(harness, { activationEnabled: false });

            const mergeGate = new MergeGateService(
                harness.db,
                harness.githubApp,
                true,
                analytics,
                harness.services.falsePositiveCandidates,
                undefined,
                trigger,
            );

            const result = await mergeGate.requestAnalysisRunFromApplication({
                organizationId: harness.organizationId,
                applicationId: fixture.appId,
                prNumber: PR_NUMBER,
            });

            // No throw, no run - and the reason is surfaced so the UI can say why nothing happened.
            expect(result).toEqual({ status: "not_started", reason: "activation_off" });
            expect(trigger.calls).toHaveLength(0);
            expect(analytics.captures.filter((capture) => capture.event === "merge_gate.activated")).toHaveLength(0);
        });

        test("the build-services-wired mergeGate has a run trigger, so the UI button is not dead", async ({
            harness,
        }) => {
            // Regression guard for the real DI. Every other case builds a MergeGateService by hand with an injected
            // trigger, which verifies the LOGIC but never the WIRING. `harness.services.mergeGate` comes from
            // buildServices - the exact graph the API serves - so this catches build-services forgetting the 7th
            // analysisRunTrigger arg. Without it, requestAnalysisRun resolves no trigger and the UI "Run analysis"
            // button always returns { status: "not_started", reason: "no_trigger" } - it can never start a run.
            const fixture = await createRepoApp(harness);
            await setActivationGate(harness);

            const result = await harness.services.mergeGate.requestAnalysisRunFromApplication({
                organizationId: harness.organizationId,
                applicationId: fixture.appId,
                prNumber: PR_NUMBER,
            });

            // The wired trigger is reached, so the request gets past the no-trigger guard. It may still not start a
            // run in the test env (no live preview), but the reason must never be "no_trigger".
            const reason = result.status === "not_started" ? result.reason : undefined;
            expect(reason).not.toBe("no_trigger");
        });
    },
});

interface RepoAppFixture {
    appId: string;
    repoId: number;
    repoFullName: string;
}

/** Create a fresh repo + linked application + open PR so each test resolves its own repo name and head. */
async function createRepoApp(harness: APITestHarness): Promise<RepoAppFixture> {
    const fakeClient = harness.githubApp.defaultClient;
    // Random (not a counter) so each test's repo is unique on the shared integration DB; 3 bytes stays within int4.
    const repoId = 500_000 + randomBytes(3).readUIntBE(0, 3);
    const repoFullName = `org/trigger-config-${repoId}`;

    fakeClient.addRepository({
        id: repoId,
        name: `trigger-config-${repoId}`,
        fullName: repoFullName,
        defaultBranch: "main",
        commits: ["base-1"],
    });
    fakeClient.addPullRequest(repoFullName, {
        number: PR_NUMBER,
        title: "Fix checkout",
        headRef: "feature/fix",
        baseSha: "base-1",
        commits: [HEAD_SHA],
    });

    const app = await harness.services.applications.createApplication({
        name: `trigger-config-${repoId}`,
        organizationId: harness.organizationId,
        architecture: ApplicationArchitecture.WEB,
        url: "https://example.com",
        file: "s3://bucket/file.png",
    });
    await harness.db.application.update({ where: { id: app.id }, data: { githubRepositoryId: repoId } });

    return { appId: app.id, repoId, repoFullName };
}

/** Enable the gate + analysis, and (by default) migrate the org to activation, on the shared org. */
async function setActivationGate(
    harness: APITestHarness,
    options: { activationEnabled?: boolean } = {},
): Promise<void> {
    const data = {
        analysisEnabled: true,
        mergeGateEnabled: true,
        activationEnabled: options.activationEnabled ?? true,
    };
    await harness.db.organizationSettings.upsert({
        where: { organizationId: harness.organizationId },
        create: { organizationId: harness.organizationId, ...data },
        update: data,
    });
}
