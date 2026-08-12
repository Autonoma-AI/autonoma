import { previewkitConfigCreateChildren } from "@autonoma/db";
import { integrationTestSuite } from "@autonoma/integration-test";
import { previewkitConfigRowValues, trustedPreviewConfigSchema } from "@autonoma/types";
import { expect } from "vitest";
import { loadConfig } from "../../src/config/load-config";
import { resolveConfig } from "../../src/config/resolver";
import { PreviewkitTestHarness } from "./harness";

async function createApplication(harness: PreviewkitTestHarness, slug = "web"): Promise<string> {
    const { organizationId } = await harness.createOrganization();
    const application = await harness.db.application.create({
        data: { name: slug, slug, architecture: "WEB", organizationId },
    });
    return application.id;
}

// Seeds an application's config row and its topology rows, standing in for the
// authoring API in apps/api (previewkit itself only reads configs, never writes
// them). Decomposed with the TRUSTED schema, the way the authoring API stores it:
// these fixtures carry deliberate `resources` overrides, and the untrusted
// variant would flatten them to the standard tier on the way in.
async function seedConfig(harness: PreviewkitTestHarness, applicationId: string, document: object): Promise<void> {
    const config = trustedPreviewConfigSchema.parse(document);
    await harness.db.previewkitConfig.create({
        data: {
            applicationId,
            document: JSON.parse(JSON.stringify(config)),
            ...previewkitConfigCreateChildren(previewkitConfigRowValues(config)),
        },
    });
}

const baseConfig = resolveConfig({
    document: {
        version: 2,
        domain: "base.example.com",
        apps: [{ name: "web", repository: "acme/web", port: 3000 }],
    },
});

integrationTestSuite({
    name: "previewkit config loading",
    createHarness: () => PreviewkitTestHarness.create(),
    cases: (test) => {
        test("loadConfig returns undefined when the application has no config", async ({ harness }) => {
            const applicationId = await createApplication(harness);

            const loaded = await loadConfig(applicationId);

            expect(loaded).toBeUndefined();
        });

        test("loadConfig resolves the stored document into a validated config", async ({ harness }) => {
            const applicationId = await createApplication(harness);
            await seedConfig(harness, applicationId, baseConfig);

            const loaded = await loadConfig(applicationId);

            expect(loaded).toBeDefined();
            expect(loaded!.apps[0]!.name).toBe("web");
            expect(loaded!.apps[0]!.repository).toBe("acme/web");
            expect(loaded!.domain).toBe("base.example.com");
        });

        test("loadConfig honors per-app/service resource overrides from a stored config", async ({ harness }) => {
            const applicationId = await createApplication(harness);
            // A stored config is a trusted, platform-authored source, so its
            // `resources` overrides are honored - unlike untrusted client input,
            // which is ignored.
            await seedConfig(harness, applicationId, {
                version: 2,
                apps: [{ name: "web", repository: "acme/web", port: 3000, resources: { cpu: "2", memory: "4Gi" } }],
                services: [{ name: "db", recipe: "postgres", resources: { cpu: "1", memory: "2Gi" } }],
            });

            const loaded = await loadConfig(applicationId);

            expect(loaded!.apps[0]!.resources).toEqual({ cpu: "2", memoryRequest: "4Gi", memoryLimit: "4Gi" });
            expect(loaded!.services[0]!.resources).toEqual({
                cpu: "1",
                memoryRequest: "2Gi",
                memoryLimit: "2Gi",
            });
        });

        test("loadConfig round-trips a document whose apps span multiple repositories", async ({ harness }) => {
            const applicationId = await createApplication(harness);
            // The single document is the whole topology: the dependency repo's
            // app lives in the same apps[] list, distinguished by `repository`,
            // with per-repo overrides in `repositories`.
            await seedConfig(harness, applicationId, {
                version: 2,
                apps: [
                    { name: "web", repository: "acme/web", port: 3000 },
                    { name: "api", repository: "acme/api", port: 4000 },
                ],
                repositories: [{ repo: "acme/api", fallback_branch: "develop" }],
                branch_convention: { type: "same_branch_name" },
            });

            const loaded = await loadConfig(applicationId);

            expect(loaded!.apps.map((app) => app.repository)).toEqual(["acme/web", "acme/api"]);
            expect(loaded!.repositories).toEqual([{ repo: "acme/api", fallback_branch: "develop" }]);
            expect(loaded!.branch_convention).toEqual({ type: "same_branch_name" });
        });

        test("loadConfig deploys what the rows say, not the document column", async ({ harness }) => {
            const applicationId = await createApplication(harness);
            await seedConfig(harness, applicationId, baseConfig);
            // The column is still written, so every other case here would pass
            // whichever one the deploy read. Doctoring it apart is what pins down
            // that a build is planned from the rows.
            await harness.db.previewkitConfig.update({
                where: { applicationId },
                data: {
                    document: {
                        version: 2,
                        apps: [{ name: "stale-from-document", repository: "acme/stale", port: 9999 }],
                    },
                },
            });

            const loaded = await loadConfig(applicationId);

            expect(loaded!.apps.map((app) => app.name)).toEqual(["web"]);
            expect(loaded!.apps[0]!.repository).toBe("acme/web");
            expect(loaded!.domain).toBe("base.example.com");
        });
    },
});
