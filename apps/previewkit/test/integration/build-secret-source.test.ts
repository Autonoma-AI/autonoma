import { integrationTestSuite } from "@autonoma/integration-test";
import { mintSecretKey, SecretKeys, SecretValues } from "@autonoma/secrets";
import { FakeKeyProvider } from "@autonoma/secrets/fake-key-provider";
import type { SecretBundle } from "@autonoma/utils";
import { expect } from "vitest";
import { BuildSecretSource, type SecretJsonFetcher } from "../../src/secrets/build-secret-source";
import { PreviewkitTestHarness } from "./harness";

const AWS_ARN = "arn:aws:secretsmanager:us-east-1:1:secret:previewkit/test";

/**
 * Stands in for AWS Secrets Manager. Counts reads, because "did this bundle come
 * out of Postgres" is only answered by AWS not being touched.
 */
class ScriptedFetcher implements SecretJsonFetcher {
    reads = 0;

    constructor(private readonly values: Record<string, string>) {}

    async fetchJson(): Promise<Record<string, string>> {
        this.reads++;
        return this.values;
    }
}

integrationTestSuite<PreviewkitTestHarness, undefined>({
    name: "BuildSecretSource",
    createHarness: () => PreviewkitTestHarness.create(),
    seed: async () => undefined,
    cases: (test) => {
        /** An app bundle whose parent row exists, so sealed values have something to hang off. */
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
            await harness.db.previewkitSecret.create({
                data: { applicationId: application.id, appName: "web", awsSecretArn: AWS_ARN },
            });

            const bundle: SecretBundle = { kind: "app", applicationId: application.id, appName: "web" };
            if (Object.keys(sealed).length > 0) {
                const provider = new FakeKeyProvider();
                await mintSecretKey({ db: harness.db, provider, keyId: "1" });
                await new SecretValues(harness.db, new SecretKeys(harness.db, provider)).put(
                    bundle,
                    Object.entries(sealed).map(([key, value]) => ({ key, value })),
                );
            }
            return bundle;
        }

        function source(harness: PreviewkitTestHarness, fetcher: SecretJsonFetcher, readFromPostgres: boolean) {
            return new BuildSecretSource(
                fetcher,
                readFromPostgres,
                new SecretValues(harness.db, new SecretKeys(harness.db, new FakeKeyProvider())),
            );
        }

        test("reads the sealed values out of Postgres without touching AWS", async ({ harness }) => {
            const bundle = await bundleWith(harness, { DATABASE_URL: "postgres://sealed" });
            const fetcher = new ScriptedFetcher({ DATABASE_URL: "postgres://aws" });

            const values = await source(harness, fetcher, true).forBundle(bundle, AWS_ARN);

            expect(values).toEqual({ DATABASE_URL: "postgres://sealed" });
            expect(fetcher.reads).toBe(0);
        });

        test("falls back to AWS for a bundle Postgres holds nothing for", async ({ harness }) => {
            const bundle = await bundleWith(harness, {});
            const fetcher = new ScriptedFetcher({ DATABASE_URL: "postgres://aws" });

            const values = await source(harness, fetcher, true).forBundle(bundle, AWS_ARN);

            expect(values).toEqual({ DATABASE_URL: "postgres://aws" });
            expect(fetcher.reads).toBe(1);
        });

        test("reads AWS while the flag is off, even with the values already sealed", async ({ harness }) => {
            const bundle = await bundleWith(harness, { DATABASE_URL: "postgres://sealed" });
            const fetcher = new ScriptedFetcher({ DATABASE_URL: "postgres://aws" });

            const values = await source(harness, fetcher, false).forBundle(bundle, AWS_ARN);

            expect(values).toEqual({ DATABASE_URL: "postgres://aws" });
            expect(fetcher.reads).toBe(1);
        });

        test("picks only the requested build_secrets keys", async ({ harness }) => {
            const bundle = await bundleWith(harness, { WANTED: "yes", OTHER: "no" });

            const picked = await source(harness, new ScriptedFetcher({}), true).forKeys(bundle, AWS_ARN, ["WANTED"]);

            expect(picked).toEqual({ WANTED: "yes" });
        });

        test("fails the build for a requested key the bundle does not have, naming the store that answered", async ({
            harness,
        }) => {
            const bundle = await bundleWith(harness, { PRESENT: "yes" });

            await expect(
                source(harness, new ScriptedFetcher({}), true).forKeys(bundle, AWS_ARN, ["PRESENT", "ABSENT"]),
            ).rejects.toThrow(/postgres.*ABSENT/s);
        });
    },
});
