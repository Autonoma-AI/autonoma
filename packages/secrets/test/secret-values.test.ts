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

secretsSuite({
    name: "SecretValues.compare",
    cases: (test) => {
        async function sealed(harness: SecretsHarness, items: { key: string; value: string }[]) {
            await mint(harness, "1");
            const bundle = await harness.createAppBundle();
            await values(harness).put(bundle, items);
            return bundle;
        }

        test("reports no difference when the two agree", async ({ harness }) => {
            const bundle = await sealed(harness, [{ key: "A", value: "one" }]);

            const diff = await values(harness).compare(bundle, new Map([["A", secretFingerprint("one")]]));

            expect(diff).toEqual({ missing: [], extra: [], mismatched: [] });
        });

        test("reports a key the authoritative store has and Postgres does not", async ({ harness }) => {
            const bundle = await sealed(harness, [{ key: "A", value: "one" }]);

            const diff = await values(harness).compare(
                bundle,
                new Map([
                    ["A", secretFingerprint("one")],
                    ["B", secretFingerprint("two")],
                ]),
            );

            expect(diff).toEqual({ missing: ["B"], extra: [], mismatched: [] });
        });

        test("reports a key Postgres has and the authoritative store does not", async ({ harness }) => {
            const bundle = await sealed(harness, [
                { key: "A", value: "one" },
                { key: "B", value: "two" },
            ]);

            const diff = await values(harness).compare(bundle, new Map([["A", secretFingerprint("one")]]));

            expect(diff).toEqual({ missing: [], extra: ["B"], mismatched: [] });
        });

        test("reports a key whose value differs", async ({ harness }) => {
            const bundle = await sealed(harness, [{ key: "A", value: "one" }]);

            const diff = await values(harness).compare(bundle, new Map([["A", secretFingerprint("changed")]]));

            expect(diff).toEqual({ missing: [], extra: [], mismatched: ["A"] });
        });

        // An un-backfilled bundle is the case that must not be mistaken for an empty one:
        // serving a read from here would show the user no secrets at all.
        test("reports every key as missing when nothing has been mirrored", async ({ harness }) => {
            await mint(harness, "1");
            const bundle = await harness.createAppBundle();

            const diff = await values(harness).compare(
                bundle,
                new Map([
                    ["A", secretFingerprint("one")],
                    ["B", secretFingerprint("two")],
                ]),
            );

            expect(diff).toEqual({ missing: ["A", "B"], extra: [], mismatched: [] });
        });

        test("compares org bundles independently of app bundles with the same key", async ({ harness }) => {
            await mint(harness, "1");
            const app = await harness.createAppBundle();
            const org = await harness.createOrgBundle();
            await values(harness).put(app, [{ key: "token", value: "app-value" }]);

            const diff = await values(harness).compare(org, new Map([["token", secretFingerprint("app-value")]]));

            expect(diff).toEqual({ missing: ["token"], extra: [], mismatched: [] });
        });
    },
});

secretsSuite({
    name: "SecretValues reads",
    cases: (test) => {
        test("lists keys with real timestamps and no decryption", async ({ harness }) => {
            await mint(harness, "1");
            const bundle = await harness.createAppBundle();
            await values(harness).put(bundle, [
                { key: "B", value: "two" },
                { key: "A", value: "x".repeat(100) },
            ]);

            const listed = await values(harness).list(bundle);

            expect(listed.map((row) => row.key)).toEqual(["A", "B"]);
            expect(listed[0]?.fingerprint).toBe(secretFingerprint("x".repeat(100)));
            expect(listed[0]?.maskedLength).toBe(32);
            expect(listed[0]?.updatedAt).toBeInstanceOf(Date);
        });

        // Empty must stay distinguishable from "no secrets" - a caller that served this
        // as a listing would show a user nothing at all for an un-migrated bundle.
        test("lists nothing for a bundle that was never mirrored", async ({ harness }) => {
            await mint(harness, "1");

            expect(await values(harness).list(await harness.createAppBundle())).toEqual([]);
        });

        test("opens a stored value", async ({ harness }) => {
            await mint(harness, "1");
            const bundle = await harness.createAppBundle();
            await values(harness).put(bundle, [{ key: "DATABASE_URL", value: "postgres://secret" }]);

            expect(await values(harness).get(bundle, "DATABASE_URL")).toBe("postgres://secret");
        });

        test("opens a value sealed by a superseded key", async ({ harness }) => {
            await mint(harness, "1");
            const bundle = await harness.createAppBundle();
            await values(harness).put(bundle, [{ key: "A", value: "one" }]);
            await mint(harness, "2");

            expect(await values(harness).get(bundle, "A")).toBe("one");
        });

        test("returns undefined for a key it does not hold", async ({ harness }) => {
            await mint(harness, "1");
            const bundle = await harness.createAppBundle();
            await values(harness).put(bundle, [{ key: "A", value: "one" }]);

            expect(await values(harness).get(bundle, "MISSING")).toBeUndefined();
        });

        test("does not read one bundle's value through another", async ({ harness }) => {
            await mint(harness, "1");
            const web = await harness.createAppBundle("web");
            const api = await harness.createAppBundle("api");
            await values(harness).put(web, [{ key: "A", value: "web-only" }]);

            expect(await values(harness).get(api, "A")).toBeUndefined();
        });

        test("reads org-scoped values too", async ({ harness }) => {
            await mint(harness, "1");
            const bundle = await harness.createOrgBundle();
            await values(harness).put(bundle, [{ key: "token", value: "neon-token" }]);

            expect(await values(harness).get(bundle, "token")).toBe("neon-token");
            expect((await values(harness).list(bundle)).map((r) => r.key)).toEqual(["token"]);
        });
    },
});
