import { integrationTestSuite } from "@autonoma/integration-test";
import { expect } from "vitest";
import { resolveConfig } from "../../src/config/resolver";
import { loadActiveConfig, loadConfigRevision } from "../../src/config/revisions";
import { PreviewkitTestHarness } from "./harness";

async function createApplication(harness: PreviewkitTestHarness, slug = "web"): Promise<string> {
    const { organizationId } = await harness.createOrganization();
    const application = await harness.db.application.create({
        data: { name: slug, slug, architecture: "WEB", organizationId },
    });
    return application.id;
}

// Seeds a config revision directly and points the Application at it, standing
// in for the future authoring API (there is no in-app writer now that the
// `.preview.yaml` import path is gone).
async function seedActiveRevision(
    harness: PreviewkitTestHarness,
    applicationId: string,
    document: object,
): Promise<string> {
    const revision = await harness.db.previewkitConfigRevision.create({
        data: { applicationId, revision: 1, schemaVersion: 1, source: "api", document },
    });
    await harness.db.application.update({
        where: { id: applicationId },
        data: { activeConfigRevisionId: revision.id },
    });
    return revision.id;
}

const baseConfig = resolveConfig({
    document: { version: 1, domain: "base.example.com", apps: [{ name: "web", port: 3000 }] },
});

integrationTestSuite({
    name: "previewkit config store",
    createHarness: () => PreviewkitTestHarness.create(),
    cases: (test) => {
        test("loadActiveConfig returns undefined when the application has no active revision", async ({ harness }) => {
            const applicationId = await createApplication(harness);

            const active = await loadActiveConfig(applicationId);

            expect(active).toBeUndefined();
        });

        test("loadActiveConfig returns undefined when the active revision id dangles", async ({ harness }) => {
            const applicationId = await createApplication(harness);
            await harness.db.application.update({
                where: { id: applicationId },
                data: { activeConfigRevisionId: "rev_does_not_exist" },
            });

            const active = await loadActiveConfig(applicationId);

            expect(active).toBeUndefined();
        });

        test("loadActiveConfig resolves the active revision into a validated config", async ({ harness }) => {
            const applicationId = await createApplication(harness);
            const revisionId = await seedActiveRevision(harness, applicationId, baseConfig);

            const active = await loadActiveConfig(applicationId);

            expect(active).toBeDefined();
            expect(active!.revisionId).toBe(revisionId);
            expect(active!.config.apps[0]!.name).toBe("web");
            expect(active!.config.domain).toBe("base.example.com");
        });

        test("loadActiveConfig honors per-app/service resource overrides from a revision", async ({ harness }) => {
            const applicationId = await createApplication(harness);
            // A revision is a trusted, platform-authored source, so its `resources`
            // overrides are honored - unlike a `.preview.yaml`, which is ignored.
            await seedActiveRevision(harness, applicationId, {
                version: 1,
                apps: [{ name: "web", port: 3000, resources: { cpu: "2", memory: "4Gi" } }],
                services: [{ name: "db", recipe: "postgres", resources: { cpu: "1", memory: "2Gi" } }],
            });

            const active = await loadActiveConfig(applicationId);

            expect(active!.config.apps[0]!.resources).toEqual({ cpu: "2", memoryRequest: "4Gi", memoryLimit: "4Gi" });
            expect(active!.config.services[0]!.resources).toEqual({
                cpu: "1",
                memoryRequest: "2Gi",
                memoryLimit: "2Gi",
            });
        });

        test("loadActiveConfig ignores an active revision id that belongs to another application", async ({
            harness,
        }) => {
            const appA = await createApplication(harness, "app-a");
            const appB = await createApplication(harness, "app-b");
            const foreignRevisionId = await seedActiveRevision(harness, appB, baseConfig);
            // Mis-set: point appA's active id at appB's revision. It must not resolve.
            await harness.db.application.update({
                where: { id: appA },
                data: { activeConfigRevisionId: foreignRevisionId },
            });

            const active = await loadActiveConfig(appA);

            expect(active).toBeUndefined();
        });

        test("loadConfigRevision only resolves a revision owned by the given application", async ({ harness }) => {
            const appA = await createApplication(harness, "app-a");
            const appB = await createApplication(harness, "app-b");
            const revisionId = await seedActiveRevision(harness, appB, baseConfig);

            expect((await loadConfigRevision(appB, revisionId))?.revisionId).toBe(revisionId);
            expect(await loadConfigRevision(appA, revisionId)).toBeUndefined();
        });
    },
});
