import { integrationTestSuite } from "@autonoma/integration-test";
import { mintSecretKey, SecretKeys, SecretValues } from "@autonoma/secrets";
import { FakeKeyProvider } from "@autonoma/secrets/fake-key-provider";
import type { SecretBundle } from "@autonoma/utils";
import { expect } from "vitest";
import { BuildSecretSource } from "../../src/secrets/build-secret-source";
import { PreviewkitTestHarness } from "./harness";

integrationTestSuite<PreviewkitTestHarness, undefined>({
    name: "BuildSecretSource",
    createHarness: () => PreviewkitTestHarness.create(),
    seed: async () => undefined,
    cases: (test) => {
        /** An Application, plus a sealed bundle under it when `sealed` names any keys. */
        async function bundleWith(
            harness: PreviewkitTestHarness,
            sealed: Record<string, string>,
        ): Promise<SecretBundle> {
            const { organizationId } = await harness.createOrganization();
            const application = await harness.db.application.create({
                data: {
                    name: `App ${crypto.randomUUID()}`,
                    slug: `app-${crypto.randomUUID()}`,
                    organizationId,
                    architecture: "WEB",
                },
            });
            const bundle: SecretBundle = { kind: "app", applicationId: application.id, appName: "web" };
            if (Object.keys(sealed).length > 0) {
                // Sealing binds the app row, so "web" has to exist in the topology.
                await harness.db.previewkitApp.create({
                    data: {
                        config: { create: { applicationId: application.id } },
                        position: 0,
                        name: "web",
                        repository: "acme/web",
                        path: ".",
                        port: 3000,
                        resourcesCpu: "250m",
                        resourcesMemory: "1Gi",
                    },
                });
                const provider = new FakeKeyProvider();
                await mintSecretKey({ db: harness.db, provider, keyId: "1" });
                await new SecretValues(harness.db, new SecretKeys(harness.db, provider)).put(
                    bundle,
                    Object.entries(sealed).map(([key, value]) => ({ key, value })),
                );
            }
            return bundle;
        }

        function source(harness: PreviewkitTestHarness): BuildSecretSource {
            return new BuildSecretSource(
                new SecretValues(harness.db, new SecretKeys(harness.db, new FakeKeyProvider())),
            );
        }

        test("reads the sealed values out of Postgres", async ({ harness }) => {
            const bundle = await bundleWith(harness, {
                DATABASE_URL: "postgres://sealed",
                API_KEY: "sk_live",
            });

            expect(await source(harness).forBundle(bundle)).toEqual({
                DATABASE_URL: "postgres://sealed",
                API_KEY: "sk_live",
            });
        });

        test("picks only the requested build_secrets keys", async ({ harness }) => {
            const bundle = await bundleWith(harness, { WANTED: "yes", OTHER: "no" });

            expect(await source(harness).forKeys(bundle, ["WANTED"])).toEqual({ WANTED: "yes" });
        });

        test("fails the build for a requested key the bundle does not have", async ({ harness }) => {
            const bundle = await bundleWith(harness, { PRESENT: "yes" });

            // An empty build arg would bake an image that boots and then misbehaves, so
            // this fails at the read instead of reaching buildctl.
            await expect(source(harness).forKeys(bundle, ["PRESENT", "ABSENT"])).rejects.toThrow(/ABSENT/);
        });

        test("fails rather than answering empty for a bundle holding nothing", async ({ harness }) => {
            // Reachable two ways: values that never landed, or a bundle whose every key
            // was deleted. There is no second store to ask either way, and a build that
            // succeeds against no credentials is worse than one that stops.
            const bundle = await bundleWith(harness, {});

            await expect(source(harness).forBundle(bundle)).rejects.toThrow(/No secret values are stored/);
        });

        test("fails clearly when the environment has no encryption key configured", async ({ harness }) => {
            const bundle = await bundleWith(harness, { API_KEY: "sk_live" });

            await expect(new BuildSecretSource().forBundle(bundle)).rejects.toThrow(/PREVIEWKIT_SECRETS_CMK/);
        });
    },
});
