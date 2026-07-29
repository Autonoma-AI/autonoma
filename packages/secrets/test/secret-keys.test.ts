import type { SecretScope } from "@autonoma/utils";
import { expect } from "vitest";
import { mintSecretKey } from "../src/mint-secret-key";
import { SecretKeys } from "../src/secret-keys";
import { FakeKeyProvider } from "./fake-key-provider";
import { type SecretsHarness, secretsSuite } from "./harness";

const SCOPE: SecretScope = { kind: "app", applicationId: "app_123", appName: "web", key: "DATABASE_URL" };

function keys(harness: SecretsHarness): SecretKeys {
    return new SecretKeys(harness.db, harness.provider);
}

function mint(harness: SecretsHarness, keyId: string): Promise<void> {
    return mintSecretKey({ db: harness.db, provider: harness.provider, keyId });
}

secretsSuite({
    name: "SecretKeys",
    cases: (test) => {
        test("seals and opens a value through the primary encryption key", async ({ harness }) => {
            await mint(harness, "1");
            const secretKeys = keys(harness);

            const sealed = (await secretKeys.primary()).encrypt("postgres://secret", SCOPE);
            const opener = await secretKeys.forEnvelope(sealed);

            expect(opener.decrypt(sealed, SCOPE)).toBe("postgres://secret");
        });

        test("wraps and unwraps each key under its own key id", async ({ harness }) => {
            await mint(harness, "1");
            await keys(harness).primary();

            expect(harness.provider.generated).toEqual([{ purpose: "previewkit-secrets", keyId: "1" }]);
            expect(harness.provider.unwrapped).toEqual([{ purpose: "previewkit-secrets", keyId: "1" }]);
        });

        test("asks the key provider only when a key is actually needed", async ({ harness }) => {
            await mint(harness, "1");

            keys(harness);

            expect(harness.provider.unwrapped).toHaveLength(0);
        });

        test("unwraps a key once and reuses it", async ({ harness }) => {
            await mint(harness, "1");
            const secretKeys = keys(harness);

            const sealed = (await secretKeys.primary()).encrypt("value", SCOPE);
            await secretKeys.primary();
            await secretKeys.forEnvelope(sealed);

            expect(harness.provider.unwrapped).toHaveLength(1);
        });

        // Nothing in the schema stops a row being deleted and its id re-minted with
        // different material. If the cache trusted the id alone, this long-lived
        // instance would keep sealing with the material it cached while every fresh
        // process unwrapped the new material, and neither could open the other's values.
        test("does not serve stale material when a key id is re-minted", async ({ harness }) => {
            await mint(harness, "1");
            const longLived = keys(harness);
            const sealedByReplaced = (await longLived.primary()).encrypt("value", SCOPE);

            await harness.db.previewkitEncryptionKey.delete({ where: { id: "1" } });
            await mint(harness, "1");

            const afterRemint = await longLived.primary();
            const sealedAfterRemint = afterRemint.encrypt("value", SCOPE);

            // A newly started process must be able to open what the long-lived one just sealed.
            const freshProcess = await keys(harness).forEnvelope(sealedAfterRemint);
            expect(freshProcess.decrypt(sealedAfterRemint, SCOPE)).toBe("value");

            // And the replaced key's material must be gone, not lingering in the cache.
            expect(() => afterRemint.decrypt(sealedByReplaced, SCOPE)).toThrow();
        });

        test("explains itself when no encryption key has been minted", async ({ harness }) => {
            await expect(keys(harness).primary()).rejects.toThrow("No primary previewkit encryption key");
        });

        test("reads values sealed by an older key after a new primary is promoted", async ({ harness }) => {
            await mint(harness, "1");
            const sealedUnderOld = (await keys(harness).primary()).encrypt("value", SCOPE);

            await mint(harness, "2");
            const afterRotation = keys(harness);
            const opener = await afterRotation.forEnvelope(sealedUnderOld);

            expect((await afterRotation.primary()).keyId).toBe("2");
            expect(opener.decrypt(sealedUnderOld, SCOPE)).toBe("value");
        });

        test("picks up a promoted key without a restart or an env change", async ({ harness }) => {
            await mint(harness, "1");
            const secretKeys = keys(harness);
            expect((await secretKeys.primary()).keyId).toBe("1");

            await mint(harness, "2");

            // The same long-lived instance, as a running API pod would be.
            expect((await secretKeys.primary()).keyId).toBe("2");
        });

        test("leaves exactly one primary behind", async ({ harness }) => {
            await mint(harness, "1");
            await mint(harness, "2");

            const primaries = await harness.db.previewkitEncryptionKey.findMany({ where: { primary: true } });

            expect(primaries.map((row) => row.id)).toEqual(["2"]);
        });

        test("refuses to reuse a key id", async ({ harness }) => {
            await mint(harness, "1");

            await expect(mint(harness, "1")).rejects.toThrow('Encryption key "1" already exists');
        });

        test("names the encryption key when it was deleted before its values were re-encrypted", async ({
            harness,
        }) => {
            await mint(harness, "1");
            const sealed = (await keys(harness).primary()).encrypt("value", SCOPE);

            await mint(harness, "2");
            await harness.db.previewkitEncryptionKey.delete({ where: { id: "1" } });

            await expect(keys(harness).forEnvelope(sealed)).rejects.toThrow(
                'sealed with key id "1": that encryption key is not in previewkit_encryption_key',
            );
        });

        test("does not commit an encryption key that could not be minted", async ({ harness }) => {
            harness.provider = new FakeKeyProvider(new Error("AccessDeniedException"));

            await expect(mint(harness, "1")).rejects.toThrow("AccessDeniedException");
            expect(await harness.db.previewkitEncryptionKey.count()).toBe(0);
        });
    },
});
