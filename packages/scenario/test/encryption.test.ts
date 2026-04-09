import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EncryptionHelper } from "../src/encryption";

function generateValidKey(): string {
    return randomBytes(32).toString("hex");
}

describe("EncryptionHelper", () => {
    it("round-trips a plaintext string", () => {
        const helper = new EncryptionHelper(generateValidKey());
        const plaintext = "my-signing-secret-123";

        const encrypted = helper.encrypt(plaintext);
        const decrypted = helper.decrypt(encrypted);

        expect(decrypted).toBe(plaintext);
    });

    it("produces different ciphertexts for the same plaintext (random IV)", () => {
        const helper = new EncryptionHelper(generateValidKey());
        const plaintext = "same-value";

        const a = helper.encrypt(plaintext);
        const b = helper.encrypt(plaintext);

        expect(a).not.toBe(b);
    });

    it("fails to decrypt with a different key", () => {
        const helper1 = new EncryptionHelper(generateValidKey());
        const helper2 = new EncryptionHelper(generateValidKey());

        const encrypted = helper1.encrypt("secret");

        expect(() => helper2.decrypt(encrypted)).toThrow();
    });

    it("handles empty string", () => {
        const helper = new EncryptionHelper(generateValidKey());

        const encrypted = helper.encrypt("");
        const decrypted = helper.decrypt(encrypted);

        expect(decrypted).toBe("");
    });

    it("handles unicode text", () => {
        const helper = new EncryptionHelper(generateValidKey());
        const plaintext = "héllo wörld 日本語 🎉";

        const encrypted = helper.encrypt(plaintext);
        const decrypted = helper.decrypt(encrypted);

        expect(decrypted).toBe(plaintext);
    });

    it("throws if key is not 32 bytes", () => {
        expect(() => new EncryptionHelper("aabbcc")).toThrow(
            "SCENARIO_ENCRYPTION_KEY must be at least 64 hex characters (32 bytes)",
        );
    });

    it("throws if key is empty", () => {
        expect(() => new EncryptionHelper("")).toThrow(
            "SCENARIO_ENCRYPTION_KEY must be at least 64 hex characters (32 bytes)",
        );
    });
});
