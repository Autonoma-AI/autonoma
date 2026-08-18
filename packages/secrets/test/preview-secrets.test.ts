import { expect } from "vitest";
import { mintSecretKey } from "../src/mint-secret-key";
import { PreviewSecrets } from "../src/preview-secrets";
import { SecretKeys } from "../src/secret-keys";
import { SecretValues } from "../src/secret-values";
import { type SecretsHarness, secretsSuite } from "./harness";

const REPO_ID = 4242;

interface SeedOptions {
    sealed?: Record<string, Record<string, string>>;
    githubRepositoryId?: number;
}

secretsSuite({
    name: "PreviewSecrets",
    cases: (test) => {
        /** An Application holding a sealed bundle per app named in `sealed`. */
        async function seedApp(harness: SecretsHarness, options: SeedOptions): Promise<{ applicationId: string }> {
            const organization = await harness.db.organization.create({
                data: { name: `Org ${crypto.randomUUID()}`, slug: `org-${crypto.randomUUID()}` },
            });
            const application = await harness.db.application.create({
                data: {
                    name: `App ${crypto.randomUUID()}`,
                    slug: `app-${crypto.randomUUID()}`,
                    organizationId: organization.id,
                    architecture: "WEB",
                    githubRepositoryId: options.githubRepositoryId ?? REPO_ID,
                },
            });
            const values = new SecretValues(harness.db, new SecretKeys(harness.db, harness.provider));
            for (const [appName, items] of Object.entries(options.sealed ?? {})) {
                // A secret is sealed against its app row, so the app has to be in the
                // topology before anything can be stored for it.
                await harness.createTopologyApp(application.id, appName);
                await values.put(
                    { kind: "app", applicationId: application.id, appName },
                    Object.entries(items).map(([key, value]) => ({ key, value })),
                );
            }
            return { applicationId: application.id };
        }

        function reader(harness: SecretsHarness): PreviewSecrets {
            return new PreviewSecrets(
                harness.db,
                new SecretValues(harness.db, new SecretKeys(harness.db, harness.provider)),
            );
        }

        test("reads the sealed preview env", async ({ harness }) => {
            await mintSecretKey({ db: harness.db, provider: harness.provider, keyId: "1" });
            const { applicationId } = await seedApp(harness, { sealed: { web: { API_KEY: "sealed", DEBUG: "1" } } });

            expect(await reader(harness).getEnvValues({ applicationId })).toEqual({
                API_KEY: "sealed",
                DEBUG: "1",
            });
        });

        test("lists the env-var names without decrypting anything", async ({ harness }) => {
            await mintSecretKey({ db: harness.db, provider: harness.provider, keyId: "1" });
            const { applicationId } = await seedApp(harness, {
                sealed: { web: { STRIPE_KEY: "sk_live", DATABASE_URL: "postgres://x" } },
            });
            const unwrapsAfterSeeding = harness.provider.unwrapped.length;

            const names = await reader(harness).getEnvVarNames({ applicationId });

            expect(names).toEqual(["DATABASE_URL", "STRIPE_KEY"]);
            // Asking which names exist must not make a plaintext value materialize: the
            // stored key columns answer it, so no key is unwrapped and nothing decrypts.
            expect(harness.provider.unwrapped).toHaveLength(unwrapsAfterSeeding);
        });

        /**
         * A caller reconstructing a past read (the classifier eval freezing an old classification) is weeks
         * behind it. Unbounded, it would be handed a key that did not exist then - and an absent key is
         * exactly what `get_preview_env` calls decisive evidence.
         */
        test("lists the bundle as it stood at a past instant, excluding keys stored since", async ({ harness }) => {
            await mintSecretKey({ db: harness.db, provider: harness.provider, keyId: "1" });
            const { applicationId } = await seedApp(harness, {
                sealed: { web: { OLD_KEY: "a", ADDED_LATER: "b" } },
            });
            const classifiedAt = new Date("2026-01-15T00:00:00Z");
            await harness.db.previewkitSecret.updateMany({
                where: { key: "OLD_KEY", app: { name: "web", config: { applicationId } } },
                data: { createdAt: new Date("2026-01-01T00:00:00Z") },
            });

            expect(await reader(harness).getEnvVarNames({ applicationId }, classifiedAt)).toEqual(["OLD_KEY"]);
            // Unbounded stays the live answer: a classification running now wants what the pods are running with.
            expect(await reader(harness).getEnvVarNames({ applicationId })).toEqual(["ADDED_LATER", "OLD_KEY"]);
        });

        test("resolves the sole stored bundle even when its app is not named web", async ({ harness }) => {
            await mintSecretKey({ db: harness.db, provider: harness.provider, keyId: "1" });
            const { applicationId } = await seedApp(harness, { sealed: { storefront: { TOKEN: "t" } } });

            expect(await reader(harness).getEnvValues({ applicationId })).toEqual({ TOKEN: "t" });
        });

        test("prefers web when the Application holds several bundles", async ({ harness }) => {
            await mintSecretKey({ db: harness.db, provider: harness.provider, keyId: "1" });
            const { applicationId } = await seedApp(harness, {
                sealed: { api: { WHICH: "api" }, web: { WHICH: "web" } },
            });

            expect(await reader(harness).getEnvValues({ applicationId })).toEqual({ WHICH: "web" });
        });

        test("never crosses to another Application sharing the repo name and id", async ({ harness }) => {
            await mintSecretKey({ db: harness.db, provider: harness.provider, keyId: "1" });
            // Two organizations onboarding the same GitHub repo is representable, so the
            // read is keyed on the Application the caller states - resolving the tenant
            // from the repo name would have to guess between these two.
            const theirs = await seedApp(harness, { sealed: { web: { OWNER: "theirs" } } });
            const mine = await seedApp(harness, { sealed: { web: { OWNER: "mine" } } });
            const client = reader(harness);

            expect(await client.getEnvValues({ applicationId: mine.applicationId })).toEqual({ OWNER: "mine" });
            expect(await client.getEnvValues({ applicationId: theirs.applicationId })).toEqual({ OWNER: "theirs" });
        });

        test("lists nothing for an application that stores no secrets", async ({ harness }) => {
            await mintSecretKey({ db: harness.db, provider: harness.provider, keyId: "1" });
            const { applicationId } = await seedApp(harness, {});

            // Truthful rather than a miss: Postgres is the only store, so this preview
            // really does run on its config's wired connections alone. The caller unions
            // those in before treating an absent name as a finding.
            expect(await reader(harness).getEnvVarNames({ applicationId })).toEqual([]);
        });

        test("refuses to hand a script an empty environment", async ({ harness }) => {
            await mintSecretKey({ db: harness.db, provider: harness.provider, keyId: "1" });
            const { applicationId } = await seedApp(harness, {});

            // A harness given no credentials runs every request unauthenticated and
            // reports the 401s back as product bugs, so this stops instead.
            await expect(reader(harness).getEnvValues({ applicationId })).rejects.toThrow(
                /No preview secrets are stored/,
            );
        });

        test("refuses for an applicationId that does not exist", async ({ harness }) => {
            await mintSecretKey({ db: harness.db, provider: harness.provider, keyId: "1" });

            await expect(reader(harness).getEnvValues({ applicationId: "app_missing" })).rejects.toThrow(
                /No preview secrets are stored/,
            );
        });

        test("refuses both reads when the environment has no encryption key", async ({ harness }) => {
            await mintSecretKey({ db: harness.db, provider: harness.provider, keyId: "1" });
            const { applicationId } = await seedApp(harness, { sealed: { web: { API_KEY: "sealed" } } });
            const noCmk = new PreviewSecrets(harness.db);

            // Including the listing: an environment that cannot read at all must not
            // answer [], which the caller states as "this preview configures nothing".
            await expect(noCmk.getEnvVarNames({ applicationId })).rejects.toThrow(/PREVIEWKIT_SECRETS_CMK/);
            await expect(noCmk.getEnvValues({ applicationId })).rejects.toThrow(/PREVIEWKIT_SECRETS_CMK/);
        });
    },
});
