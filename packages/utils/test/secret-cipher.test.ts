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
    appId: "pkapp_123",
    key: "DATABASE_URL",
};

describe("SecretCipher", () => {
    /**
     * v1 binds the app's NAME, v2 binds its row id. Both must open while the fleet
     * straddles the change - a value written by one pod has to be readable by
     * another - which is the whole reason the version rides in the envelope.
     */
    describe("envelope versions", () => {
        function v1Cipher(keyId = "1"): SecretCipher {
            return new SecretCipher(keyId, randomBytes(32), "v1");
        }

        it("seals v2 now, bound to the app row rather than its name", () => {
            const cipher = makeCipher();
            const envelope = cipher.encrypt("postgres://secret", APP_SCOPE);

            expect(envelope.startsWith("v2.")).toBe(true);
            // The whole point: the value survives its app being renamed.
            expect(cipher.decrypt(envelope, { ...APP_SCOPE, appName: "renamed" })).toBe("postgres://secret");
        });

        it("still opens a v1 envelope, which is what stored values are until the sweep runs", () => {
            const material = randomBytes(32);
            const sealed = new SecretCipher("1", material, "v1").encrypt("postgres://secret", APP_SCOPE);

            expect(sealed.startsWith("v1.")).toBe(true);
            expect(new SecretCipher("1", material).decrypt(sealed, APP_SCOPE)).toBe("postgres://secret");
        });

        it("refuses a v1 envelope whose app name has changed - the reason renames cost values", () => {
            const cipher = v1Cipher();
            const envelope = cipher.encrypt("postgres://secret", APP_SCOPE);

            expect(() => cipher.decrypt(envelope, { ...APP_SCOPE, appName: "renamed" })).toThrow();
        });

        it("refuses to seal without an appId, rather than writing something unopenable", () => {
            const cipher = makeCipher();
            const { appId, ...scopeWithoutApp } = APP_SCOPE;
            void appId;

            expect(() => cipher.encrypt("postgres://secret", scopeWithoutApp)).toThrow("without an appId");
        });

        it("refuses to seal as an unknown version", () => {
            expect(() => new SecretCipher("1", randomBytes(32), "v9")).toThrow("unknown version");
        });
    });

    describe("scopeIn", () => {
        it("derives a scope that opens what the equivalent literal sealed", () => {
            const cipher = makeCipher();
            const sealed = cipher.encrypt("value", APP_SCOPE);

            const derived = scopeIn(
                { kind: "app", applicationId: APP_SCOPE.applicationId, appName: "web", appId: APP_SCOPE.appId },
                "DATABASE_URL",
            );

            expect(cipher.decrypt(sealed, derived)).toBe("value");
        });

        it("keeps a different key in the same bundle a different scope", () => {
            const cipher = makeCipher();
            const bundle = { kind: "app", applicationId: "app_123", appName: "web", appId: "pkapp_123" } as const;
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

        /**
         * v2 binds the app ROW, so the application and the name are no longer part of
         * the authenticated data - that is what lets a value survive a rename. The
         * tenant boundary moves with it: an appId belongs to exactly one application,
         * and `SecretValues` refuses to open a row whose app points at a different one.
         */
        it("no longer binds the application or the app name", () => {
            const cipher = makeCipher();
            const sealed = cipher.encrypt("value", APP_SCOPE);

            expect(cipher.decrypt(sealed, { ...APP_SCOPE, applicationId: "app_other" })).toBe("value");
            expect(cipher.decrypt(sealed, { ...APP_SCOPE, appName: "renamed" })).toBe("value");
        });

        it("does not let separator characters re-cut one scope into another", () => {
            const cipher = makeCipher();
            const base = { kind: "app", applicationId: "a", appName: "n" } as const;
            const sealed = cipher.encrypt("value", { ...base, appId: "x:y", key: "z" });

            expect(() => cipher.decrypt(sealed, { ...base, appId: "x", key: "y:z" })).toThrow();
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
            ["an unknown version", "v9.1.AAAA"],
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
