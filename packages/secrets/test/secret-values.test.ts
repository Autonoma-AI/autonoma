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

            const row = await harness.db.previewkitSecret.findFirstOrThrow({ where: { key: "DATABASE_URL" } });
            const cipher = await new SecretKeys(harness.db, harness.provider).forEnvelope(row.envelope);

            expect(cipher.decrypt(row.envelope, scopeIn(bundle, "DATABASE_URL"))).toBe("postgres://secret");
        });

        test("never stores the plaintext", async ({ harness }) => {
            await mint(harness, "1");
            const bundle = await harness.createAppBundle();

            await values(harness).put(bundle, [{ key: "DATABASE_URL", value: "postgres://secret" }]);

            const row = await harness.db.previewkitSecret.findFirstOrThrow({ where: { key: "DATABASE_URL" } });

            expect(row.envelope).not.toContain("postgres://secret");
        });

        test("records the fingerprint and a capped length so a list need not decrypt", async ({ harness }) => {
            await mint(harness, "1");
            const bundle = await harness.createAppBundle();
            const value = "x".repeat(100);

            await values(harness).put(bundle, [{ key: "LONG", value }]);

            const row = await harness.db.previewkitSecret.findFirstOrThrow({ where: { key: "LONG" } });

            expect(row.fingerprint).toBe(secretFingerprint(value));
            expect(row.maskedLength).toBe(32);
        });

        test("stamps the encryption key that sealed each value", async ({ harness }) => {
            await mint(harness, "1");
            const bundle = await harness.createAppBundle();

            await values(harness).put(bundle, [{ key: "A", value: "one" }]);
            await mint(harness, "2");
            await values(harness).put(bundle, [{ key: "B", value: "two" }]);

            const rows = await harness.db.previewkitSecret.findMany({ orderBy: { key: "asc" } });

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

            const rows = await harness.db.previewkitSecret.findMany({ orderBy: { key: "asc" } });
            const keys = new SecretKeys(harness.db, harness.provider);
            const updated = await keys.forEnvelope(rows[0]?.envelope ?? "");

            expect(rows).toHaveLength(2);
            expect(updated.decrypt(rows[0]?.envelope ?? "", scopeIn(bundle, "A"))).toBe("one-updated");
        });

        // `updatedAt` is read as "when this value last changed" - onboarding compares it
        // against a preview's deploy time to decide whether to redeploy - so a re-assert
        // of the same value must not move it, or every check reads as drift.
        test("leaves a key untouched when it is re-asserted with the same value", async ({ harness }) => {
            await mint(harness, "1");
            const bundle = await harness.createAppBundle();
            const store = values(harness);
            await store.put(bundle, [{ key: "A", value: "one" }]);
            const sealed = await harness.db.previewkitSecret.findFirstOrThrow({ where: { key: "A" } });

            await store.put(bundle, [{ key: "A", value: "one" }]);

            const after = await harness.db.previewkitSecret.findFirstOrThrow({ where: { key: "A" } });
            expect(after.updatedAt).toEqual(sealed.updatedAt);
            expect(after.envelope).toBe(sealed.envelope);
        });

        test("writes only the keys whose values moved", async ({ harness }) => {
            await mint(harness, "1");
            const bundle = await harness.createAppBundle();
            const store = values(harness);
            await store.put(bundle, [
                { key: "A", value: "one" },
                { key: "B", value: "two" },
            ]);
            const before = await harness.db.previewkitSecret.findMany({ orderBy: { key: "asc" } });

            await store.put(bundle, [
                { key: "A", value: "one" },
                { key: "B", value: "two-updated" },
            ]);

            const after = await harness.db.previewkitSecret.findMany({ orderBy: { key: "asc" } });
            expect(after[0]?.updatedAt).toEqual(before[0]?.updatedAt);
            expect(after[1]?.updatedAt.getTime()).toBeGreaterThan(before[1]?.updatedAt.getTime() ?? 0);
        });

        test("rewrites an unchanged value once the encryption key has rotated", async ({ harness }) => {
            await mint(harness, "1");
            const bundle = await harness.createAppBundle();
            const store = values(harness);
            await store.put(bundle, [{ key: "A", value: "one" }]);
            const before = await harness.db.previewkitSecret.findFirstOrThrow({ where: { key: "A" } });

            await mint(harness, "2");
            await store.put(bundle, [{ key: "A", value: "one" }]);

            const after = await harness.db.previewkitSecret.findFirstOrThrow({ where: { key: "A" } });
            expect(after.encryptionKeyId).toBe("2");
            expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
        });

        test("re-seals an unchanged value when forced, so a broken envelope can be repaired", async ({ harness }) => {
            await mint(harness, "1");
            const bundle = await harness.createAppBundle();
            const store = values(harness);
            await store.put(bundle, [{ key: "A", value: "one" }]);
            const before = await harness.db.previewkitSecret.findFirstOrThrow({ where: { key: "A" } });

            const result = await store.put(bundle, [{ key: "A", value: "one" }], { force: true });

            const after = await harness.db.previewkitSecret.findFirstOrThrow({ where: { key: "A" } });
            expect(result.written).toEqual(["A"]);
            expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
            // The repair only means anything if the row still opens afterwards.
            expect(await store.get(bundle, "A")).toBe("one");
        });

        test("reports what it wrote, and separates that from whether a value moved", async ({ harness }) => {
            await mint(harness, "1");
            const bundle = await harness.createAppBundle();
            const store = values(harness);

            const first = await store.put(bundle, [{ key: "A", value: "one" }]);
            expect(first).toEqual({ created: true, changed: true, written: ["A"] });

            const reassert = await store.put(bundle, [{ key: "A", value: "one" }]);
            expect(reassert).toEqual({ created: false, changed: false, written: [] });

            const moved = await store.put(bundle, [{ key: "A", value: "two" }]);
            expect(moved).toEqual({ created: false, changed: true, written: ["A"] });

            // A rotation rewrites the row without the value having moved, which is why
            // `changed` and a non-empty `written` are not the same question.
            await mint(harness, "2");
            const rotated = await store.put(bundle, [{ key: "A", value: "two" }]);
            expect(rotated).toEqual({ created: false, changed: false, written: ["A"] });
        });

        test("keeps the same key in two bundles separate", async ({ harness }) => {
            await mint(harness, "1");
            const web = await harness.createAppBundle("web");
            const api = await harness.createAppBundle("api");
            const store = values(harness);

            await store.put(web, [{ key: "DATABASE_URL", value: "web-value" }]);
            await store.put(api, [{ key: "DATABASE_URL", value: "api-value" }]);

            expect(await harness.db.previewkitSecret.count()).toBe(2);
        });

        test("removes a single key", async ({ harness }) => {
            await mint(harness, "1");
            const bundle = await harness.createAppBundle();
            const store = values(harness);
            await store.put(bundle, [
                { key: "A", value: "one" },
                { key: "B", value: "two" },
            ]);

            // Reports that it removed something: the API's delete answers 404-or-not from
            // this, having no second store left to ask.
            expect(await store.remove(bundle, "A")).toBe(true);

            expect((await harness.db.previewkitSecret.findMany()).map((row) => row.key)).toEqual(["B"]);
        });

        test("reports removing an absent key rather than failing", async ({ harness }) => {
            await mint(harness, "1");
            const bundle = await harness.createAppBundle();

            expect(await values(harness).remove(bundle, "NOT_THERE")).toBe(false);
        });

        test("reports a removal against an application that holds no secrets at all", async ({ harness }) => {
            await mint(harness, "1");

            expect(
                await values(harness).remove({ kind: "app", applicationId: "app_missing", appName: "web" }, "ANY"),
            ).toBe(false);
        });

        test("reports a missing encryption key as a typed error the caller can skip on", async ({ harness }) => {
            const bundle = await harness.createAppBundle();

            await expect(values(harness).put(bundle, [{ key: "A", value: "one" }])).rejects.toThrow(
                NoPrimaryEncryptionKeyError,
            );
        });

        test("refuses to seal a value against an application that does not exist", async ({ harness }) => {
            await mint(harness, "1");
            const nonexistent = { kind: "app", applicationId: "app_missing", appName: "web" } as const;

            // The applicationId FK is what makes a bundle belong to a tenant, so a write
            // naming an unknown one is a bug in the caller, not an empty bundle.
            await expect(values(harness).put(nonexistent, [{ key: "A", value: "one" }])).rejects.toThrow();
            expect(await harness.db.previewkitSecret.count()).toBe(0);
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

        test("lists nothing for a bundle holding no keys", async ({ harness }) => {
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
    },
});

secretsSuite({
    name: "SecretValues.getAll",
    cases: (test) => {
        test("opens every value in a bundle", async ({ harness }) => {
            await mint(harness, "1");
            const bundle = await harness.createAppBundle();
            await values(harness).put(bundle, [
                { key: "A", value: "one" },
                { key: "B", value: "two" },
            ]);

            expect(await values(harness).getAll(bundle)).toEqual({ A: "one", B: "two" });
        });

        test("opens values spanning two key versions", async ({ harness }) => {
            await mint(harness, "1");
            const bundle = await harness.createAppBundle();
            await values(harness).put(bundle, [{ key: "OLD", value: "one" }]);
            await mint(harness, "2");
            await values(harness).put(bundle, [{ key: "NEW", value: "two" }]);

            expect(await values(harness).getAll(bundle)).toEqual({ OLD: "one", NEW: "two" });
        });

        // Undefined rather than {}, so a caller cannot mistake "nothing is stored" for a
        // deliberately empty environment and hand a build no credentials at all.
        test("returns undefined for a bundle holding no keys", async ({ harness }) => {
            await mint(harness, "1");

            expect(await values(harness).getAll(await harness.createAppBundle())).toBeUndefined();
        });

        test("does not leak one bundle's values into another", async ({ harness }) => {
            await mint(harness, "1");
            const web = await harness.createAppBundle("web");
            const api = await harness.createAppBundle("api");
            await values(harness).put(web, [{ key: "A", value: "web-only" }]);

            expect(await values(harness).getAll(api)).toBeUndefined();
        });
    },
});
