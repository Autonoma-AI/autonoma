import { createHash } from "node:crypto";
import { integrationTestSuite } from "@autonoma/integration-test";
import type { PreviewConfig, PreviewRedeployAppMode, SecretItem } from "@autonoma/types";
import { expect } from "vitest";
import { PreviewkitWriteService } from "../../src/previewkit/previewkit-write.service";
import type { PreviewkitSecretsUpsertResult } from "../../src/routes/onboarding/onboarding-dependencies";
import { PreviewkitConfigService } from "../../src/routes/onboarding/previewkit-config-service";
import { OnboardingTestHarness } from "../onboarding/onboarding-harness";

const REPO_FULL_NAME = "acme/web";
const PR_NUMBER = 7;

/** The independent SHA-256 fingerprint the tool contract promises (first 12 hex). */
function expectedFingerprint(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}

/** Records secret writes; delete's return is configurable to simulate present/absent keys. */
function fakeSecretWriter() {
    const upserts: { appName: string; items: SecretItem[] }[] = [];
    const deletes: { appName: string; key: string }[] = [];
    let deleteReturns = true;
    return {
        upserts,
        deletes,
        setDeletePresent(present: boolean) {
            deleteReturns = present;
        },
        upsert: async (
            _applicationId: string,
            appName: string,
            items: SecretItem[],
            _callerOrgId: string | undefined,
        ): Promise<PreviewkitSecretsUpsertResult> => {
            upserts.push({ appName, items });
            return { created: true, changed: true };
        },
        delete: async (
            _applicationId: string,
            appName: string,
            key: string,
            _callerOrgId: string | undefined,
        ): Promise<boolean> => {
            deletes.push({ appName, key });
            return deleteReturns;
        },
    };
}

/** Records per-app redeploys (with mode) and whole-environment redeploys separately. */
function fakeRedeployer() {
    const calls: { repoFullName: string; prNumber: number; appName: string; mode: PreviewRedeployAppMode }[] = [];
    const envCalls: { repoFullName: string; prNumber: number }[] = [];
    return {
        calls,
        envCalls,
        redeployApp: async (
            repoFullName: string,
            prNumber: number,
            appName: string,
            mode: PreviewRedeployAppMode,
            _callerOrgId?: string,
        ): Promise<void> => {
            calls.push({ repoFullName, prNumber, appName, mode });
        },
        redeploy: async (repoFullName: string, prNumber: number, _callerOrgId?: string): Promise<void> => {
            envCalls.push({ repoFullName, prNumber });
        },
    };
}

/** A single-app config declaring API_KEY as a build secret (so build-vs-runtime classification has something to read). */
function seedDocument() {
    return {
        version: 1,
        apps: [{ name: "web", path: ".", port: 3000, primary: true, build_secrets: ["API_KEY"] }],
        services: [],
    };
}

integrationTestSuite({
    name: "PreviewKit write tools",
    createHarness: () => OnboardingTestHarness.create(),
    seed: async (harness) => {
        const orgId = await harness.createOrg();
        const config = new PreviewkitConfigService(harness.db, {});
        return { orgId, config };
    },
    cases: (test) => {
        test("set_secret on a declared build secret rebuilds and returns the value's fingerprint", async ({
            harness,
            seedResult: { orgId, config },
        }) => {
            const appId = await harness.createApp(orgId);
            await config.save(appId, orgId, seedDocument(), []);
            const secrets = fakeSecretWriter();
            const trigger = fakeRedeployer();
            const service = new PreviewkitWriteService(config, secrets, trigger);

            const result = await service.setSecret({
                applicationId: appId,
                repoFullName: REPO_FULL_NAME,
                prNumber: PR_NUMBER,
                appName: "web",
                key: "API_KEY",
                value: "s3cr3t-value",
                organizationId: orgId,
            });

            expect(result).toEqual({
                appName: "web",
                key: "API_KEY",
                removed: false,
                fingerprint: expectedFingerprint("s3cr3t-value"),
                action: "rebuild",
            });
            expect(secrets.upserts).toEqual([{ appName: "web", items: [{ key: "API_KEY", value: "s3cr3t-value" }] }]);
            expect(trigger.calls).toEqual([
                { repoFullName: REPO_FULL_NAME, prNumber: PR_NUMBER, appName: "web", mode: "rebuild" },
            ]);
        });

        test("set_secret on a non-build key restarts instead of rebuilding", async ({
            harness,
            seedResult: { orgId, config },
        }) => {
            const appId = await harness.createApp(orgId);
            await config.save(appId, orgId, seedDocument(), []);
            const secrets = fakeSecretWriter();
            const trigger = fakeRedeployer();
            const service = new PreviewkitWriteService(config, secrets, trigger);

            const result = await service.setSecret({
                applicationId: appId,
                repoFullName: REPO_FULL_NAME,
                prNumber: PR_NUMBER,
                appName: "web",
                key: "SESSION_SECRET",
                value: "runtime-only",
                organizationId: orgId,
            });

            expect(result.action).toBe("restart");
            expect(trigger.calls[0]?.mode).toBe("restart");
        });

        test("set_secret removing an absent key throws (never a silent no-op)", async ({
            harness,
            seedResult: { orgId, config },
        }) => {
            const appId = await harness.createApp(orgId);
            await config.save(appId, orgId, seedDocument(), []);
            const secrets = fakeSecretWriter();
            secrets.setDeletePresent(false);
            const trigger = fakeRedeployer();
            const service = new PreviewkitWriteService(config, secrets, trigger);

            await expect(
                service.setSecret({
                    applicationId: appId,
                    repoFullName: REPO_FULL_NAME,
                    prNumber: PR_NUMBER,
                    appName: "web",
                    key: "API_KEY",
                    organizationId: orgId,
                }),
            ).rejects.toThrow(/not set/);
            expect(trigger.calls).toEqual([]);
        });

        test("edit_previewkit_config saves a new revision and rebuilds against it, keeping other fields", async ({
            harness,
            seedResult: { orgId, config },
        }) => {
            const appId = await harness.createApp(orgId);
            await config.save(appId, orgId, seedDocument(), []);
            const trigger = fakeRedeployer();
            const service = new PreviewkitWriteService(config, fakeSecretWriter(), trigger);

            const result = await service.editConfig({
                applicationId: appId,
                repoFullName: REPO_FULL_NAME,
                prNumber: PR_NUMBER,
                appName: "web",
                patch: { port: 4000 },
                apply: true,
                organizationId: orgId,
            });

            expect(result.applied).toBe(true);
            expect(result.app.port).toBe(4000);
            // The unpatched field is preserved.
            expect(result.app.build_secrets).toEqual(["API_KEY"]);

            // The saved config now carries the patched port (a redeploy resolves the
            // current saved config, so a plain rebuild is enough to apply the edit).
            const loaded = await config.getConfig(appId, orgId);
            expect(loaded.document.apps[0]?.port).toBe(4000);
            expect(trigger.calls).toEqual([
                { repoFullName: REPO_FULL_NAME, prNumber: PR_NUMBER, appName: "web", mode: "rebuild" },
            ]);
        });

        test("edit_previewkit_config with apply:false saves but does not deploy", async ({
            harness,
            seedResult: { orgId, config },
        }) => {
            const appId = await harness.createApp(orgId);
            await config.save(appId, orgId, seedDocument(), []);
            const trigger = fakeRedeployer();
            const service = new PreviewkitWriteService(config, fakeSecretWriter(), trigger);

            const result = await service.editConfig({
                applicationId: appId,
                repoFullName: REPO_FULL_NAME,
                prNumber: PR_NUMBER,
                appName: "web",
                patch: { port: 5000 },
                apply: false,
                organizationId: orgId,
            });

            expect(result.applied).toBe(false);
            expect(result.note).toContain("NOT deployed");
            expect(trigger.calls).toEqual([]);
            // The revision is still saved and active.
            const loaded = await config.getConfig(appId, orgId);
            expect(loaded.document.apps[0]?.port).toBe(5000);
        });

        test("edit_previewkit_config on an unknown app throws", async ({ harness, seedResult: { orgId, config } }) => {
            const appId = await harness.createApp(orgId);
            await config.save(appId, orgId, seedDocument(), []);
            const service = new PreviewkitWriteService(config, fakeSecretWriter(), fakeRedeployer());

            await expect(
                service.editConfig({
                    applicationId: appId,
                    repoFullName: REPO_FULL_NAME,
                    prNumber: PR_NUMBER,
                    appName: "does-not-exist",
                    patch: { port: 4000 },
                    apply: true,
                    organizationId: orgId,
                }),
            ).rejects.toThrow(/not in the preview config/);
        });

        test("apply_config adds a service and redeploys the whole environment", async ({
            harness,
            seedResult: { orgId, config },
        }) => {
            const appId = await harness.createApp(orgId);
            await config.save(appId, orgId, seedDocument(), []);
            const trigger = fakeRedeployer();
            const service = new PreviewkitWriteService(config, fakeSecretWriter(), trigger);

            const { document } = await service.getConfig(appId, orgId);
            const [firstApp] = document.apps;
            if (firstApp == null) throw new Error("seed document must have an app");
            // A structural change a single-app edit can't express: a new redis service.
            const newService: PreviewConfig["services"][number] = {
                name: "to-delete-cache",
                recipe: "redis",
                options: {},
                setup_tasks: [],
                resources: firstApp.resources,
            };
            const nextDocument: PreviewConfig = { ...document, services: [...document.services, newService] };

            const result = await service.applyConfig({
                applicationId: appId,
                repoFullName: REPO_FULL_NAME,
                prNumber: PR_NUMBER,
                document: nextDocument,
                apply: true,
                organizationId: orgId,
            });

            expect(result.applied).toBe(true);
            expect(result.services).toContain("to-delete-cache");
            // A topology change rebuilds the whole environment, not one app.
            expect(trigger.envCalls).toEqual([{ repoFullName: REPO_FULL_NAME, prNumber: PR_NUMBER }]);
            expect(trigger.calls).toEqual([]);
            // The service is persisted in the saved config.
            const loaded = await config.getConfig(appId, orgId);
            expect(loaded.document.services.map((s) => s.name)).toContain("to-delete-cache");
        });

        test("apply_config with apply:false saves but does not deploy", async ({
            harness,
            seedResult: { orgId, config },
        }) => {
            const appId = await harness.createApp(orgId);
            await config.save(appId, orgId, seedDocument(), []);
            const trigger = fakeRedeployer();
            const service = new PreviewkitWriteService(config, fakeSecretWriter(), trigger);

            const { document } = await service.getConfig(appId, orgId);
            const [firstApp] = document.apps;
            if (firstApp == null) throw new Error("seed document must have an app");
            const newService: PreviewConfig["services"][number] = {
                name: "staged-cache",
                recipe: "redis",
                options: {},
                setup_tasks: [],
                resources: firstApp.resources,
            };
            const nextDocument: PreviewConfig = { ...document, services: [...document.services, newService] };

            const result = await service.applyConfig({
                applicationId: appId,
                repoFullName: REPO_FULL_NAME,
                prNumber: PR_NUMBER,
                document: nextDocument,
                apply: false,
                organizationId: orgId,
            });

            expect(result.applied).toBe(false);
            expect(result.note).toContain("NOT deployed");
            expect(trigger.envCalls).toEqual([]);
            // The revision is still saved and active even though nothing redeployed.
            const loaded = await config.getConfig(appId, orgId);
            expect(loaded.document.services.map((s) => s.name)).toContain("staged-cache");
        });
    },
});
