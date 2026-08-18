import { mintSecretKey, SecretKeys, SecretValues } from "@autonoma/secrets";
import { FakeKeyProvider } from "@autonoma/secrets/fake-key-provider";
import { expect } from "vitest";
import { PreviewkitSecretsService } from "../../src/previewkit/previewkit-secrets.service";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";

const APP = "web";

apiTestSuite({
    name: "previewkit-secrets-postgres",
    cases: (test) => {
        /**
         * A store over real Postgres with a fake KMS. The database is never faked; only
         * the key seam is, so every envelope here is really sealed and really opened.
         */
        async function store(harness: APITestHarness): Promise<SecretValues> {
            await harness.db.previewkitSecret.deleteMany();
            await harness.db.previewkitEncryptionKey.deleteMany();

            const provider = new FakeKeyProvider();
            await mintSecretKey({ db: harness.db, provider, keyId: "1" });
            return new SecretValues(harness.db, new SecretKeys(harness.db, provider));
        }

        /**
         * An application with a preview topology. Every app name this suite seals
         * against has to be in it: a secret is bound to its app row, so an app the
         * topology does not name has nowhere to store one.
         */
        async function application(harness: APITestHarness, organizationId?: string): Promise<string> {
            const app = await harness.db.application.create({
                data: {
                    name: `App ${crypto.randomUUID()}`,
                    slug: `app-${crypto.randomUUID()}`,
                    organizationId: organizationId ?? harness.organizationId,
                    architecture: "WEB",
                },
            });
            await harness.seedTopology(app.id, ["web", "one", "two", "x", "theirs"]);
            return app.id;
        }

        function service(harness: APITestHarness, values?: SecretValues): PreviewkitSecretsService {
            return new PreviewkitSecretsService(harness.db, values);
        }

        test("reports the first write as created and seals the values", async ({ harness }) => {
            const values = await store(harness);
            const applicationId = await application(harness);
            const secrets = service(harness, values);

            const result = await secrets.upsert(
                applicationId,
                APP,
                [{ key: "API_KEY", value: "sk_live" }],
                harness.organizationId,
            );

            expect(result).toEqual({ created: true, changed: true });
            const rows = await harness.db.previewkitSecret.findMany({
                where: { app: { config: { applicationId } } },
            });
            expect(rows.map((row) => row.key)).toEqual(["API_KEY"]);
            expect(rows[0]?.envelope).not.toContain("sk_live");
        });

        test("reports an unchanged rewrite as unchanged, and a real edit as changed", async ({ harness }) => {
            const values = await store(harness);
            const applicationId = await application(harness);
            const secrets = service(harness, values);
            await secrets.upsert(applicationId, APP, [{ key: "API_KEY", value: "one" }], harness.organizationId);

            // Compared on the stored fingerprints, so deciding this decrypts nothing.
            expect(
                await secrets.upsert(applicationId, APP, [{ key: "API_KEY", value: "one" }], harness.organizationId),
            ).toEqual({ created: false, changed: false });
            expect(
                await secrets.upsert(applicationId, APP, [{ key: "API_KEY", value: "two" }], harness.organizationId),
            ).toEqual({ created: false, changed: true });
        });

        test("reports created false for a bundle that already holds a different key", async ({ harness }) => {
            const values = await store(harness);
            const applicationId = await application(harness);
            const secrets = service(harness, values);
            await secrets.upsert(applicationId, APP, [{ key: "OTHER", value: "x" }], harness.organizationId);

            const result = await secrets.upsert(
                applicationId,
                APP,
                [{ key: "API_KEY", value: "sk_live" }],
                harness.organizationId,
            );

            expect(result).toEqual({ created: false, changed: true });
        });

        test("writes one row per key when two writes of the same key race", async ({ harness }) => {
            const values = await store(harness);
            const applicationId = await application(harness);
            const secrets = service(harness, values);

            await Promise.all([
                secrets.upsert(applicationId, APP, [{ key: "API_KEY", value: "one" }], harness.organizationId),
                secrets.upsert(applicationId, APP, [{ key: "API_KEY", value: "one" }], harness.organizationId),
            ]);

            expect(await harness.db.previewkitSecret.count({ where: { app: { config: { applicationId } } } })).toBe(1);
            expect(await secrets.getValue(applicationId, APP, "API_KEY", harness.organizationId)).toBe("one");
        });

        test("lists masked summaries without unwrapping a key", async ({ harness }) => {
            const values = await store(harness);
            const applicationId = await application(harness);
            const secrets = service(harness, values);
            await secrets.upsert(
                applicationId,
                APP,
                [
                    { key: "B_KEY", value: "second" },
                    { key: "A_KEY", value: "first" },
                ],
                harness.organizationId,
            );

            const listed = await secrets.list(applicationId, APP, harness.organizationId);

            expect(listed.map((entry) => entry.key)).toEqual(["A_KEY", "B_KEY"]);
            expect(JSON.stringify(listed)).not.toContain("first");
        });

        test("reads a single value back in the clear, and answers undefined for an absent key", async ({ harness }) => {
            const values = await store(harness);
            const applicationId = await application(harness);
            const secrets = service(harness, values);
            await secrets.upsert(applicationId, APP, [{ key: "API_KEY", value: "sk_live" }], harness.organizationId);

            expect(await secrets.getValue(applicationId, APP, "API_KEY", harness.organizationId)).toBe("sk_live");
            expect(await secrets.getValue(applicationId, APP, "NOPE", harness.organizationId)).toBeUndefined();
        });

        test("deletes once and reports the second attempt as nothing to do", async ({ harness }) => {
            const values = await store(harness);
            const applicationId = await application(harness);
            const secrets = service(harness, values);
            await secrets.upsert(applicationId, APP, [{ key: "API_KEY", value: "sk_live" }], harness.organizationId);

            expect(await secrets.delete(applicationId, APP, "API_KEY", harness.organizationId)).toBe(true);
            expect(await secrets.delete(applicationId, APP, "API_KEY", harness.organizationId)).toBe(false);
        });

        test("never answers for an application in another organization", async ({ harness }) => {
            const values = await store(harness);
            const other = await harness.db.organization.create({
                data: { name: "Other", slug: `other-${crypto.randomUUID()}` },
            });
            const foreign = await application(harness, other.id);
            const secrets = service(harness, values);
            // Seeded as the owner, then read as a different caller.
            await secrets.upsert(foreign, APP, [{ key: "API_KEY", value: "theirs" }], other.id);

            // [] and false rather than throwing: a 404 that differs from "no secrets"
            // would tell the caller the application exists.
            expect(await secrets.list(foreign, APP, harness.organizationId)).toEqual([]);
            expect(await secrets.getValue(foreign, APP, "API_KEY", harness.organizationId)).toBeUndefined();
            expect(await secrets.delete(foreign, APP, "API_KEY", harness.organizationId)).toBe(false);
            expect(await secrets.listApps(foreign, harness.organizationId)).toEqual([]);
        });

        test("refuses rather than answering emptily when the environment has no encryption key", async ({
            harness,
        }) => {
            await store(harness);
            const applicationId = await application(harness);
            // No store: an environment with no CMK cannot unwrap a key, so returning []
            // would read as "you have no secrets" when the truth is "cannot tell".
            const secrets = service(harness, undefined);

            await expect(secrets.list(applicationId, APP, harness.organizationId)).rejects.toThrow(
                /PREVIEWKIT_SECRETS_CMK/,
            );
        });

        test("drops an app from listApps once its last key is deleted", async ({ harness }) => {
            const values = await store(harness);
            const applicationId = await application(harness);
            const secrets = service(harness, values);
            await secrets.upsert(applicationId, APP, [{ key: "API_KEY", value: "sk_live" }], harness.organizationId);

            expect(await secrets.listApps(applicationId, harness.organizationId)).toEqual([APP]);

            // A bundle is its rows, so emptying it removes it - the UI's bundle picker
            // stops offering an app that has nothing left to show.
            await secrets.delete(applicationId, APP, "API_KEY", harness.organizationId);
            expect(await secrets.listApps(applicationId, harness.organizationId)).toEqual([]);
        });
    },
});
