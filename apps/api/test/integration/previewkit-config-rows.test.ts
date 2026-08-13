import { previewkitConfigRowsInclude } from "@autonoma/db";
import { integrationTestSuite } from "@autonoma/integration-test";
import { documentFromPreviewkitConfigRows, trustedPreviewConfigSchema } from "@autonoma/types";
import { expect } from "vitest";
import { PreviewkitConfigService } from "../../src/routes/onboarding/previewkit-config-service";
import { OnboardingTestHarness } from "../onboarding/onboarding-harness";

const REPO_FULL_NAME = "acme/topology";

function document(overrides: Record<string, unknown> = {}) {
    return {
        version: 2,
        apps: [
            { name: "web", repository: REPO_FULL_NAME, port: 3000, primary: true },
            { name: "api", repository: REPO_FULL_NAME, port: 4000 },
        ],
        ...overrides,
    };
}

integrationTestSuite({
    name: "PreviewKit config topology rows",
    createHarness: () => OnboardingTestHarness.create(),
    seed: async (harness) => {
        const orgId = await harness.createOrg();
        return { orgId, config: new PreviewkitConfigService(harness.db, {}) };
    },
    cases: (test) => {
        test("a saved config composes back out of its rows unchanged", async ({
            harness,
            seedResult: { orgId, config },
        }) => {
            const appId = await harness.createApp(orgId);
            await harness.linkPreviewRepo(appId, orgId, REPO_FULL_NAME);
            await config.save(
                appId,
                orgId,
                document({
                    domain: "preview.example.com",
                    repositories: [{ repo: REPO_FULL_NAME, fallback_branch: "develop" }],
                    branch_convention: { type: "regex", pattern: "^feat/(.*)$", replacement: "feature/$1" },
                    hooks: { pre_deploy: [{ app: "api", command: "pnpm migrate" }], post_deploy: [] },
                    services: [{ name: "db", recipe: "postgres", options: { database: "preview" } }],
                }),
            );

            const stored = await harness.db.previewkitConfig.findUniqueOrThrow({
                where: { applicationId: appId },
                include: previewkitConfigRowsInclude,
            });
            const composed = trustedPreviewConfigSchema.parse(documentFromPreviewkitConfigRows(stored));

            expect(stored.document).toBeNull();
            expect(composed.apps.map((app) => app.name)).toEqual(["web", "api"]);
            expect(composed.domain).toBe("preview.example.com");
            expect(composed.hooks.pre_deploy).toEqual([{ app: "api", command: "pnpm migrate" }]);
            expect(composed.services[0]?.options).toEqual({ database: "preview" });
        });

        test("re-saving replaces the topology rows rather than accumulating them", async ({
            harness,
            seedResult: { orgId, config },
        }) => {
            const appId = await harness.createApp(orgId);
            await harness.linkPreviewRepo(appId, orgId, REPO_FULL_NAME);
            await config.save(appId, orgId, document());

            // Reorder, drop an app, and add a connection - a rename would orphan
            // rows if the children were merged instead of replaced.
            await config.save(appId, orgId, {
                version: 2,
                apps: [
                    {
                        name: "api",
                        repository: REPO_FULL_NAME,
                        port: 4000,
                        connections: [{ key: "SELF_URL", value: "{{api.url}}" }],
                    },
                ],
            });

            const stored = await harness.db.previewkitConfig.findUniqueOrThrow({
                where: { applicationId: appId },
                include: previewkitConfigRowsInclude,
            });

            expect(stored.apps.map((app) => app.name)).toEqual(["api"]);
            expect(stored.apps[0]?.position).toBe(0);
            expect(stored.apps[0]?.connections.map((connection) => connection.key)).toEqual(["SELF_URL"]);
            expect(trustedPreviewConfigSchema.parse(documentFromPreviewkitConfigRows(stored)).apps).toHaveLength(1);
        });

        /**
         * Saves no longer write the column, but the retired values are still there on
         * every config saved before the stop-write. Filling it with something that
         * disagrees with the rows is what proves a reader cannot quietly fall back to
         * it while it remains droppable.
         */
        test("getConfig serves the rows, not a leftover document column", async ({
            harness,
            seedResult: { orgId, config },
        }) => {
            const appId = await harness.createApp(orgId);
            await harness.linkPreviewRepo(appId, orgId, REPO_FULL_NAME);
            await config.save(appId, orgId, document());

            await harness.db.previewkitConfig.update({
                where: { applicationId: appId },
                data: {
                    document: {
                        version: 2,
                        apps: [{ name: "stale-from-document", repository: REPO_FULL_NAME, port: 9999, primary: true }],
                    },
                },
            });

            const served = await config.getConfig(appId, orgId);

            expect(served.document.apps.map((app) => app.name)).toEqual(["web", "api"]);
            expect(served.document.apps[0]?.port).toBe(3000);
        });

        test("deleting the application takes the topology rows with it", async ({
            harness,
            seedResult: { orgId, config },
        }) => {
            const appId = await harness.createApp(orgId);
            await harness.linkPreviewRepo(appId, orgId, REPO_FULL_NAME);
            await config.save(appId, orgId, document());
            const { id: configId } = await harness.db.previewkitConfig.findUniqueOrThrow({
                where: { applicationId: appId },
                select: { id: true },
            });

            await harness.db.application.delete({ where: { id: appId } });

            expect(await harness.db.previewkitConfigApp.count({ where: { configId } })).toBe(0);
            expect(await harness.db.previewkitConfig.count({ where: { id: configId } })).toBe(0);
        });
    },
});
