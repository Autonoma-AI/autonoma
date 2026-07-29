import { scopeIn } from "@autonoma/utils";
import { expect } from "vitest";
import { mintSecretKey } from "../src/mint-secret-key";
import { NoPrimaryEncryptionKeyError } from "../src/no-primary-encryption-key-error";
import { secretFingerprint } from "../src/secret-fingerprint";
import { SecretKeys } from "../src/secret-keys";
import { SecretValues } from "../src/secret-values";
import { type SecretsHarness, secretsSuite } from "./harness";

function values(harness: SecretsHarness): SecretValues {
    return new SecretValues(harness.db, new SecretKeys(harness.db, harness.provider));
}

function mint(harness: SecretsHarness, keyId: string): Promise<void> {
    return mintSecretKey({ db: harness.db, provider: harness.provider, keyId });
}

secretsSuite({
    name: "SecretValues",
    cases: (test) => {
        test("seals a value that decrypts back under its own scope", async ({ harness }) => {
            await mint(harness, "1");
            const bundle = await harness.createAppBundle();

            await values(harness).put(bundle, [{ key: "DATABASE_URL", value: "postgres://secret" }]);

            const row = await harness.db.previewkitSecretValue.findFirstOrThrow({ where: { key: "DATABASE_URL" } });
            const cipher = await new SecretKeys(harness.db, harness.provider).forEnvelope(row.envelope);

            expect(cipher.decrypt(row.envelope, scopeIn(bundle, "DATABASE_URL"))).toBe("postgres://secret");
        });

        test("never stores the plaintext", async ({ harness }) => {
            await mint(harness, "1");
            const bundle = await harness.createAppBundle();

            await values(harness).put(bundle, [{ key: "DATABASE_URL", value: "postgres://secret" }]);

            const row = await harness.db.previewkitSecretValue.findFirstOrThrow({ where: { key: "DATABASE_URL" } });

            expect(row.envelope).not.toContain("postgres://secret");
        });

        test("records the fingerprint and a capped length so a list need not decrypt", async ({ harness }) => {
            await mint(harness, "1");
            const bundle = await harness.createAppBundle();
            const value = "x".repeat(100);

            await values(harness).put(bundle, [{ key: "LONG", value }]);

            const row = await harness.db.previewkitSecretValue.findFirstOrThrow({ where: { key: "LONG" } });

            expect(row.fingerprint).toBe(secretFingerprint(value));
            expect(row.maskedLength).toBe(32);
        });

        test("stamps the encryption key that sealed each value", async ({ harness }) => {
            await mint(harness, "1");
            const bundle = await harness.createAppBundle();

            await values(harness).put(bundle, [{ key: "A", value: "one" }]);
            await mint(harness, "2");
            await values(harness).put(bundle, [{ key: "B", value: "two" }]);

            const rows = await harness.db.previewkitSecretValue.findMany({ orderBy: { key: "asc" } });

            expect(rows.map((row) => [row.key, row.encryptionKeyId])).toEqual([
                ["A", "1"],
                ["B", "2"],
            ]);
        });

        test("overwrites a key in place and leaves the others alone", async ({ harness }) => {
            await mint(harness, "1");
            const bundle = await harness.createAppBundle();
            const store = values(harness);

            await store.put(bundle, [
                { key: "A", value: "one" },
                { key: "B", value: "two" },
            ]);
            await store.put(bundle, [{ key: "A", value: "one-updated" }]);

            const rows = await harness.db.previewkitSecretValue.findMany({ orderBy: { key: "asc" } });
            const keys = new SecretKeys(harness.db, harness.provider);
            const updated = await keys.forEnvelope(rows[0]?.envelope ?? "");

            expect(rows).toHaveLength(2);
            expect(updated.decrypt(rows[0]?.envelope ?? "", scopeIn(bundle, "A"))).toBe("one-updated");
        });

        test("keeps the same key in two bundles separate", async ({ harness }) => {
            await mint(harness, "1");
            const web = await harness.createAppBundle("web");
            const api = await harness.createAppBundle("api");
            const store = values(harness);

            await store.put(web, [{ key: "DATABASE_URL", value: "web-value" }]);
            await store.put(api, [{ key: "DATABASE_URL", value: "api-value" }]);

            expect(await harness.db.previewkitSecretValue.count()).toBe(2);
        });

        test("removes a single key", async ({ harness }) => {
            await mint(harness, "1");
            const bundle = await harness.createAppBundle();
            const store = values(harness);
            await store.put(bundle, [
                { key: "A", value: "one" },
                { key: "B", value: "two" },
            ]);

            await store.remove(bundle, "A");

            expect((await harness.db.previewkitSecretValue.findMany()).map((row) => row.key)).toEqual(["B"]);
        });

        test("treats removing an absent key as a no-op", async ({ harness }) => {
            await mint(harness, "1");
            const bundle = await harness.createAppBundle();

            await expect(values(harness).remove(bundle, "NOT_THERE")).resolves.toBeUndefined();
        });

        test("seals and removes org-scoped values too", async ({ harness }) => {
            await mint(harness, "1");
            const bundle = await harness.createOrgBundle();
            const store = values(harness);

            await store.put(bundle, [{ key: "token", value: "neon-token" }]);
            const row = await harness.db.previewkitOrgSecretValue.findFirstOrThrow({ where: { key: "token" } });
            const cipher = await new SecretKeys(harness.db, harness.provider).forEnvelope(row.envelope);

            expect(cipher.decrypt(row.envelope, scopeIn(bundle, "token"))).toBe("neon-token");

            await store.remove(bundle, "token");
            expect(await harness.db.previewkitOrgSecretValue.count()).toBe(0);
        });

        test("reports a missing encryption key as a typed error the caller can skip on", async ({ harness }) => {
            const bundle = await harness.createAppBundle();

            await expect(values(harness).put(bundle, [{ key: "A", value: "one" }])).rejects.toThrow(
                NoPrimaryEncryptionKeyError,
            );
        });

        test("skips a bundle that has no parent row rather than failing", async ({ harness }) => {
            await mint(harness, "1");
            const unregistered = { kind: "app", applicationId: "app_missing", appName: "web" } as const;

            await expect(values(harness).put(unregistered, [{ key: "A", value: "one" }])).resolves.toBeUndefined();
            expect(await harness.db.previewkitSecretValue.count()).toBe(0);
        });

        // The Restrict FK is what turns "retired rows are never deleted" from a
        // documented convention into something the database enforces.
        test("refuses to delete an encryption key that still has values", async ({ harness }) => {
            await mint(harness, "1");
            const bundle = await harness.createAppBundle();
            await values(harness).put(bundle, [{ key: "A", value: "one" }]);

            await expect(harness.db.previewkitEncryptionKey.delete({ where: { id: "1" } })).rejects.toThrow();
        });

        test("allows deleting an encryption key once nothing references it", async ({ harness }) => {
            await mint(harness, "1");
            const bundle = await harness.createAppBundle();
            const store = values(harness);
            await store.put(bundle, [{ key: "A", value: "one" }]);

            await mint(harness, "2");
            await store.put(bundle, [{ key: "A", value: "one" }]);

            await expect(harness.db.previewkitEncryptionKey.delete({ where: { id: "1" } })).resolves.toBeTruthy();
        });
    },
});
