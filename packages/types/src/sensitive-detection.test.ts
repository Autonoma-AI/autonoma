/// <reference types="node" />
import { generateKeyPairSync, randomBytes, randomInt } from "node:crypto";
import { describe, expect, it } from "vitest";
import { detectSensitive } from "./sensitive-detection";

// Deterministic-ish helpers. We use real randomness (node:crypto) but assert
// statistical properties over many samples, so the suite validates the
// classifier's behavior rather than a single hand-picked string.

function randomToken(byteLength: number, encoding: "base64url" | "hex"): string {
    return randomBytes(byteLength).toString(encoding);
}

describe("detectSensitive - private keys (random)", () => {
    it("flags freshly generated PEM private keys of every common type", () => {
        const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
        const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
        const ed25519 = generateKeyPairSync("ed25519", {});

        for (let i = 0; i < 8; i++) {
            const keys = [
                generateKeyPairSync("ed25519", {}).privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
                rsa.privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
                ec.privateKey.export({ type: "sec1", format: "pem" }).toString(),
                ed25519.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
            ];
            for (const pem of keys) {
                const result = detectSensitive("SOME_RANDOM_NAME", pem);
                expect(result.sensitive).toBe(true);
                expect(result.reason).toBe("value-pattern");
            }
        }
    });
});

describe("detectSensitive - random high-entropy strings", () => {
    it("flags random base64url and hex tokens of token-like length", () => {
        for (let i = 0; i < 100; i++) {
            const byteLength = randomInt(16, 48);
            const encoding = i % 2 === 0 ? "base64url" : "hex";
            const token = randomToken(byteLength, encoding);
            const result = detectSensitive("FOO", token);
            expect(result.sensitive, `expected ${token} to be sensitive`).toBe(true);
            // High-entropy random blobs are caught by entropy (or pattern if they
            // happen to match a provider shape).
            expect(["entropy", "value-pattern"]).toContain(result.reason);
        }
    });
});

describe("detectSensitive - known provider token shapes", () => {
    const cases: [string, string][] = [
        ["GH_TOKEN", `ghp_${randomToken(20, "hex")}aaaaaaaaaaaaaa`],
        ["AWS_ID", "AKIAIOSFODNN7EXAMPLE"],
        ["GOOGLE_KEY", `AIza${randomToken(26, "base64url").slice(0, 35).padEnd(35, "a")}`],
        ["DATABASE_URL", "postgres://admin:s3cr3tpw@db.internal:5432/app"],
        ["MONGO_URL", "mongodb://user:p4ssword@mongo:27017/app"],
        ["JDBC_URL", "jdbc:postgresql://user:pass@db:5432/app"],
    ];

    it.each(cases)("flags %s by value pattern", (key, value) => {
        const result = detectSensitive(key, value);
        expect(result.sensitive).toBe(true);
    });

    it("flags a JWT-shaped value", () => {
        const jwt = `eyJ${randomToken(16, "base64url")}.eyJ${randomToken(24, "base64url")}.${randomToken(24, "base64url")}`;
        expect(detectSensitive("FOO", jwt).sensitive).toBe(true);
    });
});

describe("detectSensitive - sensitive key names", () => {
    const cases: [string, string][] = [
        ["SLACK_TOKEN", "xoxb-not-a-real-token"],
        ["KV_REST_API_TOKEN", "local-dev-token"],
        ["STRIPE_SECRET_KEY", "placeholder"],
        ["DATABASE_PASSWORD", "hunter2"],
        ["SENTRY_DSN", "https://abc@o0.ingest.sentry.io/0"],
        ["AWS_SECRET_ACCESS_KEY", "shortish"],
        ["TEMPORAL_API_KEY", "tmprl_realkeyvalue123"],
        ["SESSION_SECRET", "changeme"],
    ];

    it.each(cases)("flags %s by key name", (key, value) => {
        expect(detectSensitive(key, value).sensitive).toBe(true);
    });
});

describe("detectSensitive - non-secret config values (from the env editor)", () => {
    // Real examples from the Previewkit env editor that must NOT be flagged.
    const cases: [string, string][] = [
        ["KV_URL", "redis://cache:6379"],
        ["APP_URL", "{{web-app.url}}"],
        ["NODE_ENV", "production"],
        ["MONGO_URI", "mongodb://{{db.host}}:{{db.port}}/preview?replicaSet=rs0&directConnection=true"],
        ["CLERK_DEBUG", "false"],
        ["NEXT_RUNTIME", "nodejs"],
        ["KV_REST_API_URL", "http://{{cache.host}}:{{cache.port}}"],
        ["TEMPORAL_ADDRESS", "{{temporal.host}}:{{temporal.port}}"],
        ["TEMPORAL_API_KEY", "http://{{api.host}}:{{api.port}}"], // template wins over the key name
        ["API_NODE_ENDPOINT", "{{db-api.url}}"],
        ["TEMPORAL_NAMESPACE", "default"],
        ["AI_FORCE_REGENERATE", "false"],
        ["CLERK_ENABLE_MIDDLEWARE", "true"],
        ["API_PROPERTY_FETCH_OPTIMIZATION_ENABLED", "false"],
        ["SENTRY_SAMPLE_RATE", "1"],
        ["EXPRESS_PORT", "3008"],
        ["ENVIRONMENT", "development"],
        ["NEXT_PUBLIC_POSTHOG_KEY", "phc_publishableandfineinthebundle"], // public by design
        ["", ""],
        // URLs are not secrets (credentialed connection strings are, tested elsewhere).
        ["FOO", "https://google.com"],
        ["FOO", "https://www.google.com/search?q=test&hl=en"],
        ["FOO", "http://localhost:3000"],
        ["FOO", "google.com"],
        ["FOO", "www.some-long-domain.example.com/a/b/c/d/e"],
        ["FOO", "redis://cache:6379"], // connection URL without inline credentials
        ["FOO", "postgres://db.internal:5432/app"], // no user:pass -> not flagged
        // Booleans / numbers / very short values are never secrets, even under a sensitive key.
        ["FEATURE_SECRET", "true"],
        ["API_TOKEN", "false"],
        ["STRIPE_SECRET_KEY", "no"],
        ["SOME_SECRET", "x"],
        ["RETRIES", "3"],
        ["SENTRY_SAMPLE_RATE", "0.5"],
    ];

    it.each(cases)("does not flag %s", (key, value) => {
        expect(detectSensitive(key, value).sensitive).toBe(false);
    });

    it("does not flag the reserved built-in vars", () => {
        expect(detectSensitive("AUTONOMA_PREVIEWKIT", "true").sensitive).toBe(false);
        expect(detectSensitive("AUTONOMA_PREVIEWKIT_URL", "https://x.preview.autonoma.app").sensitive).toBe(false);
    });
});

describe("detectSensitive - random non-secret values", () => {
    it("does not flag short / low-entropy enum-like values", () => {
        const benign = [
            "production",
            "development",
            "true",
            "false",
            "nodejs",
            "default",
            "info",
            "debug",
            "1",
            "3000",
        ];
        for (let i = 0; i < 50; i++) {
            const value = benign[randomInt(0, benign.length)]!;
            expect(detectSensitive("LOG_LEVEL", value).sensitive).toBe(false);
        }
    });
});
