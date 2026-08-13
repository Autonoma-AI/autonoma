import { previewkitConfigCreateChildren } from "@autonoma/db";
import { integrationTestSuite } from "@autonoma/integration-test";
import { previewkitConfigRowValues, trustedPreviewConfigSchema } from "@autonoma/types";
import { expect } from "vitest";
import { resolveSdkConfig } from "../src/sdk-config-resolver";
import { ScenarioTestHarness } from "./scenario-harness";

const SIGNING_SECRET = "test-secret";
const STORED_SDK_URL = "https://api.preview.autonoma.app/api/autonoma";

/**
 * Seeds the one app the endpoint resolution reads - which app hosts the handler,
 * and the path it declares (or does not) - as the topology rows the resolver
 * composes from. A partial config is no longer storable: the rows carry the
 * repository and port as columns, so the seed has to be a whole valid config.
 */
async function seedConfig(
    harness: ScenarioTestHarness,
    applicationId: string,
    app: { name: string; sdk_implemented?: boolean; sdk_path?: string },
): Promise<void> {
    const config = trustedPreviewConfigSchema.parse({
        version: 2,
        apps: [
            {
                name: app.name,
                repository: "acme/web",
                port: 3000,
                primary: true,
                sdk_implemented: app.sdk_implemented ?? false,
                sdk_path: app.sdk_path,
            },
        ],
        services: [],
    });

    await harness.db.previewkitConfig.create({
        data: { applicationId, ...previewkitConfigCreateChildren(previewkitConfigRowValues(config)) },
    });
}

integrationTestSuite({
    name: "resolveSdkConfig",
    createHarness: () => ScenarioTestHarness.create(),
    seed: async (harness) => {
        // Only the org is shared: `PreviewkitConfig` is unique per application, so a
        // case that declares one needs an application of its own.
        const orgId = await harness.createOrg();
        return { orgId };
    },
    cases: (test) => {
        test("keeps the stored endpoint when the application has no preview config", async ({
            harness,
            seedResult: { orgId },
        }) => {
            const { appId, deploymentId } = await harness.createApp(orgId, {
                webhookUrl: STORED_SDK_URL,
                signingSecret: SIGNING_SECRET,
            });

            const config = await resolveSdkConfig({
                applicationId: appId,
                deploymentId,
                db: harness.db,
                encryption: harness.encryption,
            });

            expect(config.sdkUrl).toBe(STORED_SDK_URL);
        });

        test("re-points the endpoint at the path the config declares", async ({ harness, seedResult: { orgId } }) => {
            const { appId, deploymentId } = await harness.createApp(orgId, {
                webhookUrl: STORED_SDK_URL,
                signingSecret: SIGNING_SECRET,
            });
            await seedConfig(harness, appId, { name: "api", sdk_implemented: true, sdk_path: "/autonoma" });

            const config = await resolveSdkConfig({
                applicationId: appId,
                deploymentId,
                db: harness.db,
                encryption: harness.encryption,
            });

            expect(config.sdkUrl).toBe("https://api.preview.autonoma.app/autonoma");
        });

        test("keeps the stored endpoint when the config declares no path", async ({
            harness,
            seedResult: { orgId },
        }) => {
            // The distinction that protects an endpoint registered by hand at a
            // non-conventional path: a config with no `sdk_path` must not rewrite it.
            const registered = "https://api.customer.com/internal/seed";
            const { appId, deploymentId } = await harness.createApp(orgId, {
                webhookUrl: registered,
                signingSecret: SIGNING_SECRET,
            });
            await seedConfig(harness, appId, { name: "web", sdk_implemented: true });

            const config = await resolveSdkConfig({
                applicationId: appId,
                deploymentId,
                db: harness.db,
                encryption: harness.encryption,
            });

            expect(config.sdkUrl).toBe(registered);
        });

        test("reads the path off the primary app when no app declares the SDK role", async ({
            harness,
            seedResult: { orgId },
        }) => {
            const { appId, deploymentId } = await harness.createApp(orgId, {
                webhookUrl: STORED_SDK_URL,
                signingSecret: SIGNING_SECRET,
            });
            await seedConfig(harness, appId, { name: "web", sdk_path: "/seed" });

            const config = await resolveSdkConfig({
                applicationId: appId,
                deploymentId,
                db: harness.db,
                encryption: harness.encryption,
            });

            expect(config.sdkUrl).toBe("https://api.preview.autonoma.app/seed");
        });

        test("takes an explicit override verbatim", async ({ harness, seedResult: { orgId } }) => {
            const { appId, deploymentId } = await harness.createApp(orgId, {
                webhookUrl: STORED_SDK_URL,
                signingSecret: SIGNING_SECRET,
            });
            await seedConfig(harness, appId, { name: "api", sdk_implemented: true, sdk_path: "/autonoma" });

            const config = await resolveSdkConfig({
                applicationId: appId,
                deploymentId,
                db: harness.db,
                encryption: harness.encryption,
                sdkUrlOverride: "http://localhost:3000/somewhere-else",
            });

            expect(config.sdkUrl).toBe("http://localhost:3000/somewhere-else");
        });
    },
});
