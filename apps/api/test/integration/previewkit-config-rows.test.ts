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

            // Drop an app and add a connection to the survivor.
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
         * The whole reason apps are diffed rather than replaced: the row id is what
         * secrets, instances and builds hang off, so an app that survives a save has
         * to survive it as the SAME row. A full replace looks identical from the
         * document's side and silently detaches every dependent.
         */
        test("an app that survives a save keeps its row id", async ({ harness, seedResult: { orgId, config } }) => {
            const appId = await harness.createApp(orgId);
            await harness.linkPreviewRepo(appId, orgId, REPO_FULL_NAME);
            await config.save(appId, orgId, document());

            const before = await harness.db.previewkitApp.findMany({
                where: { config: { applicationId: appId } },
                select: { id: true, name: true },
                orderBy: { name: "asc" },
            });

            // Same apps, one edited, one reordered ahead of it.
            await config.save(appId, orgId, {
                version: 2,
                apps: [
                    { name: "api", repository: REPO_FULL_NAME, port: 4100 },
                    { name: "web", repository: REPO_FULL_NAME, port: 3000, primary: true },
                ],
            });

            const after = await harness.db.previewkitApp.findMany({
                where: { config: { applicationId: appId } },
                select: { id: true, name: true, port: true, position: true },
                orderBy: { name: "asc" },
            });

            expect(after.map((app) => app.id)).toEqual(before.map((app) => app.id));
            expect(after.find((app) => app.name === "api")?.port).toBe(4100);
            expect(after.find((app) => app.name === "api")?.position).toBe(0);
        });

        test("an app the save no longer names is deleted", async ({ harness, seedResult: { orgId, config } }) => {
            const appId = await harness.createApp(orgId);
            await harness.linkPreviewRepo(appId, orgId, REPO_FULL_NAME);
            await config.save(appId, orgId, document());

            await config.save(appId, orgId, {
                version: 2,
                apps: [{ name: "web", repository: REPO_FULL_NAME, port: 3000, primary: true }],
            });

            const remaining = await harness.db.previewkitApp.findMany({
                where: { config: { applicationId: appId } },
                select: { name: true },
            });
            expect(remaining.map((app) => app.name)).toEqual(["web"]);
        });

        /**
         * Two apps trading names is NOT a rename under diff-by-name: incoming "api"
         * matches the existing "api" row, so the rows keep their names and only their
         * attributes move across. Worth pinning because it is the shape a user's
         * "rename" arrives in today, and it shows why a real rename is not expressible
         * until an operation can say so - the id follows the name, not the app.
         */
        test("apps that trade names keep their rows and exchange attributes", async ({
            harness,
            seedResult: { orgId, config },
        }) => {
            const appId = await harness.createApp(orgId);
            await harness.linkPreviewRepo(appId, orgId, REPO_FULL_NAME);
            await config.save(appId, orgId, document());
            const before = await harness.db.previewkitApp.findMany({
                where: { config: { applicationId: appId } },
                select: { id: true },
            });

            await config.save(appId, orgId, {
                version: 2,
                apps: [
                    { name: "api", repository: REPO_FULL_NAME, port: 3000, primary: true },
                    { name: "web", repository: REPO_FULL_NAME, port: 4000 },
                ],
            });

            const stored = await harness.db.previewkitApp.findMany({
                where: { config: { applicationId: appId } },
                select: { id: true, name: true, port: true },
                orderBy: { name: "asc" },
            });
            expect(stored.map(({ name, port }) => ({ name, port }))).toEqual([
                { name: "api", port: 3000 },
                { name: "web", port: 4000 },
            ]);
            // Same rows throughout - the names did not move, the ports did.
            expect(stored.map((app) => app.id).sort()).toEqual(before.map((app) => app.id).sort());
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

            expect(await harness.db.previewkitApp.count({ where: { configId } })).toBe(0);
            expect(await harness.db.previewkitConfig.count({ where: { id: configId } })).toBe(0);
        });
    },
});
