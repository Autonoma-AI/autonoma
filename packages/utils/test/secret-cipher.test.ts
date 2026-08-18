import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SecretCipher, readEnvelopeKeyId, scopeFor, type SecretScope } from "../src/secret-cipher";

function makeCipher(keyId = "1"): SecretCipher {
    return new SecretCipher(keyId, randomBytes(32));
}

const APP_SCOPE: SecretScope = {
    kind: "app",
    appId: "pkapp_123",
    key: "DATABASE_URL",
};

describe("SecretCipher", () => {
    describe("envelope versions", () => {
        it("seals v2, bound to the app row", () => {
            const cipher = makeCipher();
            const envelope = cipher.encrypt("postgres://secret", APP_SCOPE);

            expect(envelope.startsWith("v2.")).toBe(true);
            expect(cipher.decrypt(envelope, APP_SCOPE)).toBe("postgres://secret");
        });

        /**
         * v1 bound `(applicationId, appName, key)` and was readable only until the
         * sweep re-sealed the last of it. Anything still in that shape is a value
         * nobody re-sealed, and the honest answer is to refuse it rather than to
         * read it under authenticated data that no longer means the same thing.
         */
        it("refuses a v1 envelope outright", () => {
            const cipher = makeCipher();

            expect(() => cipher.decrypt("v1.1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", APP_SCOPE)).toThrow(
                "Unrecognized secret envelope",
            );
        });
    });

    describe("scopeFor", () => {
        it("derives a scope that opens what the equivalent literal sealed", () => {
            const cipher = makeCipher();
            const sealed = cipher.encrypt("value", APP_SCOPE);

            expect(cipher.decrypt(sealed, scopeFor("pkapp_123", "DATABASE_URL"))).toBe("value");
        });

        it("keeps a different key in the same app a different scope", () => {
            const cipher = makeCipher();
            const sealed = cipher.encrypt("value", scopeFor("pkapp_123", "DATABASE_URL"));

            expect(() => cipher.decrypt(sealed, scopeFor("pkapp_123", "REDIS_URL"))).toThrow();
        });
    });

    describe("key generations", () => {
        it("refuses an envelope sealed by another generation", () => {
            const sealed = makeCipher("1").encrypt("value", APP_SCOPE);

            expect(() => makeCipher("2").decrypt(sealed, APP_SCOPE)).toThrow(
                'Cannot decrypt a secret sealed with key id "1" using key id "2"',
            );
        });

        it("refuses a value sealed by different material under the same key id", () => {
            const sealed = makeCipher("1").encrypt("value", APP_SCOPE);

            expect(() => makeCipher("1").decrypt(sealed, APP_SCOPE)).toThrow();
        });

        it("rejects a key id that would break envelope parsing", () => {
            expect(() => new SecretCipher("1.2", randomBytes(32))).toThrow('Malformed secret key id "1.2"');
        });

        it("rejects key material that is not 32 bytes", () => {
            expect(() => new SecretCipher("1", randomBytes(16))).toThrow("expected 32 bytes, got 16");
        });
    });

    describe("scope binding", () => {
        it("refuses a ciphertext moved to another app", () => {
            const cipher = makeCipher();
            const sealed = cipher.encrypt("value", APP_SCOPE);

            expect(() => cipher.decrypt(sealed, { ...APP_SCOPE, appId: "pkapp_other" })).toThrow();
        });

        it("refuses a ciphertext moved to another key", () => {
            const cipher = makeCipher();
            const sealed = cipher.encrypt("value", APP_SCOPE);

            expect(() => cipher.decrypt(sealed, { ...APP_SCOPE, key: "OTHER_KEY" })).toThrow();
        });

        it("does not let separator characters re-cut one scope into another", () => {
            const cipher = makeCipher();
            const sealed = cipher.encrypt("value", scopeFor("x:y", "z"));

            expect(() => cipher.decrypt(sealed, scopeFor("x", "y:z"))).toThrow();
        });

        it("refuses a modified payload", () => {
            const cipher = makeCipher();
            const [version, keyId, payload] = cipher.encrypt("value", APP_SCOPE).split(".");
            const flipped = Buffer.from(payload ?? "", "base64");
            flipped[flipped.length - 1] ^= 0xff;

            expect(() => cipher.decrypt(`${version}.${keyId}.${flipped.toString("base64")}`, APP_SCOPE)).toThrow();
        });

        it.each([
            ["an unversioned envelope", "notbase64"],
            ["a retired version", "v1.1.AAAA"],
            ["a missing field", "v2.AAAA"],
            ["an extra field", "v2.1.AAAA.AAAA"],
        ])("refuses %s", (_label, envelope) => {
            const cipher = makeCipher();

            expect(() => cipher.decrypt(envelope, APP_SCOPE)).toThrow("Unrecognized secret envelope");
            expect(() => readEnvelopeKeyId(envelope)).toThrow("Unrecognized secret envelope");
        });

        it("refuses a truncated payload", () => {
            const cipher = makeCipher();

            expect(() => cipher.decrypt("v2.1.AAAA", APP_SCOPE)).toThrow("truncated");
        });
    });
});
