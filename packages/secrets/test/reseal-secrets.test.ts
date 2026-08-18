import { SecretCipher, scopeIn } from "@autonoma/utils";
import { expect } from "vitest";
import { mintSecretKey } from "../src/mint-secret-key";
import { resealSecrets } from "../src/reseal-secrets";
import { secretFingerprint } from "../src/secret-fingerprint";
import { SecretKeys } from "../src/secret-keys";
import { SecretValues } from "../src/secret-values";
import { secretsSuite, type SecretsHarness } from "./harness";

/**
 * Writes a row sealed the OLD way - v1 authenticated data, bound to the app's name.
 * Nothing in the codebase can produce one any more, which is exactly why the sweep
 * exists and why the test has to forge one.
 */
async function seedV1Secret(
    harness: SecretsHarness,
    bundle: { applicationId: string; appName: string; appId: string },
    key: string,
    value: string,
): Promise<void> {
    const keys = new SecretKeys(harness.db, harness.provider);
    const primary = await keys.primary();
    const v1 = new SecretCipher(primary.keyId, await harness.keyMaterial(primary.keyId), "v1");
    const envelope = v1.encrypt(value, scopeIn({ kind: "app", ...bundle }, key));

    await harness.db.previewkitSecret.create({
        data: {
            applicationId: bundle.applicationId,
            appName: bundle.appName,
            appId: bundle.appId,
            key,
            envelope,
            encryptionKeyId: primary.keyId,
            fingerprint: secretFingerprint(value),
            maskedLength: value.length,
        },
    });
}

secretsSuite({
    name: "resealSecrets",
    cases: (test) => {
        test("moves a v1 envelope to v2 and keeps the value readable throughout", async ({ harness }) => {
            await mintSecretKey({ db: harness.db, provider: harness.provider, keyId: "1" });
            const bundle = await harness.createAppBundle();
            await seedV1Secret(harness, bundle, "DATABASE_URL", "postgres://secret");

            const before = await harness.db.previewkitSecret.findFirstOrThrow({ where: { key: "DATABASE_URL" } });
            expect(before.envelope.startsWith("v1.")).toBe(true);

            const outcome = await resealSecrets(harness.db, new SecretKeys(harness.db, harness.provider));

            expect(outcome).toEqual({ resealed: 1, unopenable: 0 });
            const after = await harness.db.previewkitSecret.findFirstOrThrow({ where: { key: "DATABASE_URL" } });
            expect(after.envelope.startsWith("v2.")).toBe(true);

            const values = new SecretValues(harness.db, new SecretKeys(harness.db, harness.provider));
            expect(await values.get(bundle, "DATABASE_URL")).toBe("postgres://secret");
        });

        test("survives the rename that a v1 envelope could not", async ({ harness }) => {
            await mintSecretKey({ db: harness.db, provider: harness.provider, keyId: "1" });
            const bundle = await harness.createAppBundle();
            await seedV1Secret(harness, bundle, "API_KEY", "sk_live_1");

            await resealSecrets(harness.db, new SecretKeys(harness.db, harness.provider));

            // The app is renamed in the topology and on the secret row; the envelope
            // is bound to the row id, so the value still opens.
            await harness.db.previewkitApp.update({ where: { id: bundle.appId }, data: { name: "renamed" } });
            await harness.db.previewkitSecret.updateMany({
                where: { appId: bundle.appId },
                data: { appName: "renamed" },
            });

            const values = new SecretValues(harness.db, new SecretKeys(harness.db, harness.provider));
            expect(await values.get({ ...bundle, appName: "renamed" }, "API_KEY")).toBe("sk_live_1");
        });

        test("leaves a row it cannot open byte-for-byte alone", async ({ harness }) => {
            await mintSecretKey({ db: harness.db, provider: harness.provider, keyId: "1" });
            const bundle = await harness.createAppBundle();
            await seedV1Secret(harness, bundle, "API_KEY", "sk_live_1");

            // How a v1 row really goes bad: the app was renamed while its envelope was
            // still bound to the old name, so the authenticated data no longer matches
            // and the GCM tag check fails. The sweep cannot rescue it.
            await harness.db.previewkitSecret.updateMany({
                where: { appId: bundle.appId },
                data: { appName: "renamed-under-v1" },
            });
            const before = await harness.db.previewkitSecret.findFirstOrThrow({ where: { key: "API_KEY" } });

            const outcome = await resealSecrets(harness.db, new SecretKeys(harness.db, harness.provider));

            expect(outcome).toEqual({ resealed: 0, unopenable: 1 });
            const after = await harness.db.previewkitSecret.findFirstOrThrow({ where: { key: "API_KEY" } });
            expect(after.envelope).toBe(before.envelope);
            expect(after.encryptionKeyId).toBe(before.encryptionKeyId);
        });

        test("is a no-op the second time", async ({ harness }) => {
            await mintSecretKey({ db: harness.db, provider: harness.provider, keyId: "1" });
            const bundle = await harness.createAppBundle();
            await seedV1Secret(harness, bundle, "DATABASE_URL", "postgres://secret");

            const keys = new SecretKeys(harness.db, harness.provider);
            await resealSecrets(harness.db, keys);
            expect(await resealSecrets(harness.db, keys)).toEqual({ resealed: 0, unopenable: 0 });
        });
    },
});
