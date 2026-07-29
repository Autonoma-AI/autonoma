import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SecretCipher, readEnvelopeKeyId, scopeIn, type SecretScope } from "../src/secret-cipher";

function makeCipher(keyId = "1"): SecretCipher {
    return new SecretCipher(keyId, randomBytes(32));
}

const APP_SCOPE: SecretScope = {
    kind: "app",
    applicationId: "app_123",
    appName: "web",
    key: "DATABASE_URL",
};

const ORG_SCOPE: SecretScope = {
    kind: "org",
    organizationId: "org_123",
    name: "neon",
    key: "token",
};

describe("SecretCipher", () => {
    it("round-trips a value in an app scope", () => {
        const cipher = makeCipher();

        expect(cipher.decrypt(cipher.encrypt("postgres://secret", APP_SCOPE), APP_SCOPE)).toBe("postgres://secret");
    });

    it("round-trips a value in an org scope", () => {
        const cipher = makeCipher();

        expect(cipher.decrypt(cipher.encrypt("neon-token", ORG_SCOPE), ORG_SCOPE)).toBe("neon-token");
    });

    it("round-trips empty and unicode values", () => {
        const cipher = makeCipher();

        expect(cipher.decrypt(cipher.encrypt("", APP_SCOPE), APP_SCOPE)).toBe("");
        expect(cipher.decrypt(cipher.encrypt("héllo 日本語 🎉", APP_SCOPE), APP_SCOPE)).toBe("héllo 日本語 🎉");
    });

    it("round-trips a value larger than a KMS Encrypt payload would allow", () => {
        const cipher = makeCipher();
        const pem = "x".repeat(8192);

        expect(cipher.decrypt(cipher.encrypt(pem, APP_SCOPE), APP_SCOPE)).toBe(pem);
    });

    it("produces a different envelope each time (random IV)", () => {
        const cipher = makeCipher();

        expect(cipher.encrypt("same", APP_SCOPE)).not.toBe(cipher.encrypt("same", APP_SCOPE));
    });

    it("stamps its key id into the envelope", () => {
        const cipher = makeCipher("7");

        expect(readEnvelopeKeyId(cipher.encrypt("value", APP_SCOPE))).toBe("7");
    });

    // scopeIn exists so callers stop hand-building scopes. That is only safe if a
    // derived scope authenticates identically to the literal it replaces.
    describe("scopeIn", () => {
        it("derives a scope that opens what the equivalent literal sealed", () => {
            const cipher = makeCipher();
            const sealed = cipher.encrypt("value", APP_SCOPE);

            const derived = scopeIn(
                { kind: "app", applicationId: APP_SCOPE.applicationId, appName: "web" },
                "DATABASE_URL",
            );

            expect(cipher.decrypt(sealed, derived)).toBe("value");
        });

        it("derives an org scope that opens what the equivalent literal sealed", () => {
            const cipher = makeCipher();
            const sealed = cipher.encrypt("value", ORG_SCOPE);

            const derived = scopeIn({ kind: "org", organizationId: ORG_SCOPE.organizationId, name: "neon" }, "token");

            expect(cipher.decrypt(sealed, derived)).toBe("value");
        });

        it("keeps a different key in the same bundle a different scope", () => {
            const cipher = makeCipher();
            const bundle = { kind: "app", applicationId: "app_123", appName: "web" } as const;
            const sealed = cipher.encrypt("value", scopeIn(bundle, "DATABASE_URL"));

            expect(() => cipher.decrypt(sealed, scopeIn(bundle, "REDIS_URL"))).toThrow();
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
        it("refuses a ciphertext moved to another application", () => {
            const cipher = makeCipher();
            const sealed = cipher.encrypt("value", APP_SCOPE);

            expect(() => cipher.decrypt(sealed, { ...APP_SCOPE, applicationId: "app_other" })).toThrow();
        });

        it("refuses a ciphertext moved to another app bundle or key", () => {
            const cipher = makeCipher();
            const sealed = cipher.encrypt("value", APP_SCOPE);

            expect(() => cipher.decrypt(sealed, { ...APP_SCOPE, appName: "api" })).toThrow();
            expect(() => cipher.decrypt(sealed, { ...APP_SCOPE, key: "OTHER_KEY" })).toThrow();
        });

        it("refuses a ciphertext moved to another organization", () => {
            const cipher = makeCipher();
            const sealed = cipher.encrypt("value", ORG_SCOPE);

            expect(() => cipher.decrypt(sealed, { ...ORG_SCOPE, organizationId: "org_other" })).toThrow();
            expect(() => cipher.decrypt(sealed, { ...ORG_SCOPE, name: "other" })).toThrow();
        });

        it("does not let separator characters re-cut one scope into another", () => {
            const cipher = makeCipher();
            const sealed = cipher.encrypt("value", { kind: "app", applicationId: "a", appName: "x:y", key: "z" });

            expect(() =>
                cipher.decrypt(sealed, { kind: "app", applicationId: "a", appName: "x", key: "y:z" }),
            ).toThrow();
        });
    });

    describe("tamper detection", () => {
        it("refuses a modified payload", () => {
            const cipher = makeCipher();
            const [version, keyId, payload] = cipher.encrypt("value", APP_SCOPE).split(".");
            const flipped = Buffer.from(payload ?? "", "base64");
            flipped[flipped.length - 1] ^= 0xff;

            expect(() => cipher.decrypt(`${version}.${keyId}.${flipped.toString("base64")}`, APP_SCOPE)).toThrow();
        });

        it.each([
            ["an unversioned envelope", "notbase64"],
            ["an unknown version", "v2.1.AAAA"],
            ["a missing field", "v1.AAAA"],
            ["an extra field", "v1.1.AAAA.AAAA"],
        ])("refuses %s", (_label, envelope) => {
            const cipher = makeCipher();

            expect(() => cipher.decrypt(envelope, APP_SCOPE)).toThrow("Unrecognized secret envelope");
            expect(() => readEnvelopeKeyId(envelope)).toThrow("Unrecognized secret envelope");
        });

        it("refuses a truncated payload", () => {
            const cipher = makeCipher();

            expect(() => cipher.decrypt("v1.1.AAAA", APP_SCOPE)).toThrow("truncated");
        });
    });
});
