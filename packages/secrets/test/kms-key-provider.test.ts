import { ThirdPartyError } from "@autonoma/errors";
import { expect } from "vitest";
import { keyEncryptionContext } from "../src/key-encryption-context";
import { KmsKeyProvider } from "../src/kms-key-provider";
import { CMK_ALIAS, type KmsHarness, kmsSuite } from "./kms-harness";

function provider(harness: KmsHarness, cmkId: string = CMK_ALIAS): KmsKeyProvider {
    return new KmsKeyProvider(harness.kms, cmkId);
}

kmsSuite({
    name: "KmsKeyProvider",
    cases: (test) => {
        test("mints key material of the length SecretCipher requires", async ({ harness }) => {
            const { material } = await provider(harness).generate(keyEncryptionContext("1"));

            expect(material.length).toBe(32);
        });

        test("round-trips key material through a CMK alias", async ({ harness }) => {
            const kms = provider(harness);

            const { material, wrapped } = await kms.generate(keyEncryptionContext("1"));
            const unwrapped = await kms.unwrap(wrapped, keyEncryptionContext("1"));

            expect(Buffer.from(unwrapped).equals(Buffer.from(material))).toBe(true);
        });

        test("never returns the material inside the wrapped blob", async ({ harness }) => {
            const { material, wrapped } = await provider(harness).generate(keyEncryptionContext("1"));

            expect(Buffer.from(wrapped).includes(Buffer.from(material))).toBe(false);
        });

        // The property the storage model leans on: wrapped keys live in the
        // database next to the values they protect, so a blob must not open
        // under a key id other than the one it was minted for.
        test("refuses to unwrap a key under a different key's context", async ({ harness }) => {
            const kms = provider(harness);
            const { wrapped } = await kms.generate(keyEncryptionContext("1"));

            await expect(kms.unwrap(wrapped, keyEncryptionContext("2"))).rejects.toThrow(ThirdPartyError);
        });

        test("refuses to unwrap a key with no context at all", async ({ harness }) => {
            const kms = provider(harness);
            const { wrapped } = await kms.generate(keyEncryptionContext("1"));

            await expect(kms.unwrap(wrapped, {})).rejects.toThrow(ThirdPartyError);
        });

        test("reports a failed unwrap as a third-party error naming KMS", async ({ harness }) => {
            const failure = await provider(harness)
                .unwrap(Buffer.from("not a wrapped key"), keyEncryptionContext("1"))
                .catch((err: unknown) => err);

            expect(failure).toBeInstanceOf(ThirdPartyError);
            expect(failure).toMatchObject({ provider: "AWS KMS" });
        });

        test("reports an unusable CMK as a third-party error rather than hanging", async ({ harness }) => {
            const missingCmk = provider(harness, "alias/previewkit-secrets-does-not-exist");

            await expect(missingCmk.generate(keyEncryptionContext("1"))).rejects.toThrow(ThirdPartyError);
        });
    },
});
