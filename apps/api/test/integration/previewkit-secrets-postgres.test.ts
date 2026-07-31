import { mintSecretKey, SecretKeys, SecretValues } from "@autonoma/secrets";
import { FakeKeyProvider } from "@autonoma/secrets/fake-key-provider";
import { expect } from "vitest";
import { PreviewkitSecretsService } from "../../src/previewkit/previewkit-secrets.service";
import { OrgSecretsService } from "../../src/routes/org-secrets/org-secrets.service";
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
            await harness.db.previewkitSecretValue.deleteMany();
            await harness.db.previewkitOrgSecretValue.deleteMany();
            await harness.db.previewkitEncryptionKey.deleteMany();

            const provider = new FakeKeyProvider();
            await mintSecretKey({ db: harness.db, provider, keyId: "1" });
            return new SecretValues(harness.db, new SecretKeys(harness.db, provider));
        }

        async function application(harness: APITestHarness, organizationId?: string): Promise<string> {
            const app = await harness.db.application.create({
                data: {
                    name: `App ${crypto.randomUUID()}`,
                    slug: `app-${crypto.randomUUID()}`,
                    organizationId: organizationId ?? harness.organizationId,
                    architecture: "WEB",
                },
            });
            return app.id;
        }

        function service(harness: APITestHarness, values?: SecretValues): PreviewkitSecretsService {
            return new PreviewkitSecretsService(harness.db, values);
        }

        test("registers the bundle on first write and seals the values", async ({ harness }) => {
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
            const rows = await harness.db.previewkitSecretValue.findMany({ where: { key: "API_KEY" } });
            expect(rows).toHaveLength(1);
            // No AWS secret backs a bundle now, so there is no ARN to record.
            const bundle = await harness.db.previewkitSecret.findFirstOrThrow({ where: { applicationId } });
            expect(bundle.awsSecretArn).toBeNull();
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

        test("reports created false for a bundle another writer already registered", async ({ harness }) => {
            const values = await store(harness);
            const applicationId = await application(harness);
            // Registered out of band, so the write hits the unique constraint rather than
            // seeing the row on a prior read. This is the path a racing caller takes.
            await harness.db.previewkitSecret.create({ data: { applicationId, appName: APP } });

            const result = await service(harness, values).upsert(
                applicationId,
                APP,
                [{ key: "API_KEY", value: "sk_live" }],
                harness.organizationId,
            );

            expect(result).toEqual({ created: false, changed: true });
        });

        test("registers a new bundle exactly once when two writes race", async ({ harness }) => {
            const values = await store(harness);
            const applicationId = await application(harness);
            const secrets = service(harness, values);

            // Check-then-create let both of these decide to create the bundle, and the
            // loser surfaced a unique violation as a 500.
            const results = await Promise.all([
                secrets.upsert(applicationId, APP, [{ key: "API_KEY", value: "one" }], harness.organizationId),
                secrets.upsert(applicationId, APP, [{ key: "API_KEY", value: "one" }], harness.organizationId),
            ]);

            expect(results.filter((result) => result.created)).toHaveLength(1);
            expect(await harness.db.previewkitSecret.count({ where: { applicationId } })).toBe(1);
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
            await harness.db.previewkitSecret.create({ data: { applicationId, appName: APP } });

            await expect(secrets.list(applicationId, APP, harness.organizationId)).rejects.toThrow(
                /PREVIEWKIT_SECRETS_CMK/,
            );
        });

        test("registers an org bundle once when two writes race", async ({ harness }) => {
            const values = await store(harness);
            const orgSecrets = new OrgSecretsService(harness.db, values);

            await Promise.all([
                orgSecrets.upsert(harness.organizationId, "neon", [{ key: "token", value: "a" }]),
                orgSecrets.upsert(harness.organizationId, "neon", [{ key: "token", value: "a" }]),
            ]);

            expect(await harness.db.previewkitOrgSecret.count({ where: { name: "neon" } })).toBe(1);
        });

        test("org secrets round-trip, and a delete of an absent key is a 404", async ({ harness }) => {
            const values = await store(harness);
            const orgSecrets = new OrgSecretsService(harness.db, values);

            await orgSecrets.upsert(harness.organizationId, "neon", [{ key: "token", value: "neon-token" }]);

            expect((await orgSecrets.list(harness.organizationId, "neon")).map((entry) => entry.key)).toEqual([
                "token",
            ]);
            const row = await harness.db.previewkitOrgSecret.findFirstOrThrow({ where: { name: "neon" } });
            expect(row.awsSecretArn).toBeNull();

            await expect(orgSecrets.delete(harness.organizationId, "neon", "missing")).rejects.toThrow(/not found/);
            await orgSecrets.delete(harness.organizationId, "neon", "token");
            expect(await orgSecrets.list(harness.organizationId, "neon")).toEqual([]);
        });
    },
});
