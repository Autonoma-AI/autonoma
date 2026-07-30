import { mintSecretKey, SecretKeys, SecretValues } from "@autonoma/secrets";
import { FakeKeyProvider } from "@autonoma/secrets/fake-key-provider";
import type { SecretBundle } from "@autonoma/utils";
import { expect } from "vitest";
import { SecretValueMirror } from "../../src/previewkit/secret-value-mirror";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";

const SEALING_FAILED = new Error("kms unavailable");

apiTestSuite({
    name: "secret-value-mirror",
    cases: (test) => {
        /** An app bundle with its parent row registered, so sealed values have something to hang off. */
        async function bundle(harness: APITestHarness): Promise<SecretBundle> {
            const application = await harness.db.application.create({
                data: {
                    name: `App ${crypto.randomUUID()}`,
                    slug: `app-${crypto.randomUUID()}`,
                    organizationId: harness.organizationId,
                    architecture: "WEB",
                },
            });
            await harness.db.previewkitSecret.create({
                data: { applicationId: application.id, appName: "web", awsSecretArn: "arn:aws:secretsmanager:::web" },
            });
            return { kind: "app", applicationId: application.id, appName: "web" };
        }

        /**
         * Clears the environment's keys and sealed values.
         *
         * The API harness gives no per-test isolation (tests coexist behind random
         * slugs), and both matter here: a leftover key would make the no-key case pass
         * while proving nothing, and leftover values would break the row counts.
         * Values first - their key FK is Restrict.
         */
        async function reset(harness: APITestHarness): Promise<void> {
            await harness.db.previewkitSecretValue.deleteMany();
            await harness.db.previewkitOrgSecretValue.deleteMany();
            await harness.db.previewkitEncryptionKey.deleteMany();
        }

        /** Mints the environment's encryption key, with a provider that always works. */
        async function mintKey(harness: APITestHarness): Promise<FakeKeyProvider> {
            const provider = new FakeKeyProvider();
            await mintSecretKey({ db: harness.db, provider, keyId: "1" });
            return provider;
        }

        function mirror(harness: APITestHarness, options: { readsFromPostgres: boolean; failWith?: Error }) {
            const provider = new FakeKeyProvider(options.failWith);
            return new SecretValueMirror(
                new SecretValues(harness.db, new SecretKeys(harness.db, provider)),
                options.readsFromPostgres,
            );
        }

        test("fails the request when a write cannot be mirrored and Postgres serves reads", async ({ harness }) => {
            await reset(harness);
            await mintKey(harness);
            const target = await bundle(harness);

            // A bundle that already holds values keeps serving the stale one for a key
            // whose write failed - no per-bundle fallback can see that, which is why the
            // request has to fail instead.
            await expect(
                mirror(harness, { readsFromPostgres: true, failWith: SEALING_FAILED }).put(target, [
                    { key: "API_KEY", value: "new" },
                ]),
            ).rejects.toThrow(/kms unavailable/);
        });

        test("swallows the same failure while AWS still serves reads", async ({ harness }) => {
            await reset(harness);
            await mintKey(harness);
            const target = await bundle(harness);

            // The authoritative write already succeeded upstream, so throwing would break
            // a working operation to protect a copy nothing reads.
            await expect(
                mirror(harness, { readsFromPostgres: false, failWith: SEALING_FAILED }).put(target, [
                    { key: "API_KEY", value: "new" },
                ]),
            ).resolves.toBeUndefined();
        });

        test("mirrors a removal, so a deleted key stops being served", async ({ harness }) => {
            await reset(harness);
            const provider = await mintKey(harness);
            const target = await bundle(harness);
            await new SecretValues(harness.db, new SecretKeys(harness.db, provider)).put(target, [
                { key: "API_KEY", value: "old" },
            ]);

            await mirror(harness, { readsFromPostgres: true }).remove(target, "API_KEY");

            // Removal needs no key - it is a delete - so the only failure it can hit is
            // the database itself, which the shared guard rethrows the same way `put`'s
            // does.
            expect(await harness.db.previewkitSecretValue.findMany({ where: { key: "API_KEY" } })).toEqual([]);
        });

        test("does not fail a request in an environment that has minted no key", async ({ harness }) => {
            await reset(harness);
            const target = await bundle(harness);

            // Nothing is mirrored at all here, so every read falls back to AWS wholesale
            // and no value can go stale - a provisioning step to finish, not a request to
            // reject.
            await expect(
                mirror(harness, { readsFromPostgres: true }).put(target, [{ key: "API_KEY", value: "new" }]),
            ).resolves.toBeUndefined();
        });

        test("mirrors a write that succeeds, whichever store serves reads", async ({ harness }) => {
            await reset(harness);
            await mintKey(harness);
            const target = await bundle(harness);

            await mirror(harness, { readsFromPostgres: true }).put(target, [{ key: "API_KEY", value: "sealed" }]);

            const stored = await harness.db.previewkitSecretValue.findMany({ where: { key: "API_KEY" } });
            expect(stored).toHaveLength(1);
            expect(stored[0]?.envelope).not.toContain("sealed");
        });
    },
});
