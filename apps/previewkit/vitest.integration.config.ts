import { generateKeyPairSync } from "node:crypto";
import { defineConfig } from "vitest/config";

// src/env.ts validates the whole server env at import, and src/db imports it, so the suite cannot
// load without GitHub App credentials and the hostname HMAC key. No test talks to GitHub or mints a
// preview hostname, so these only have to satisfy the schemas: GITHUB_PRIVATE_KEY is base64-encoded
// PEM, minted per run rather than committed as key material.
const throwawayPrivateKey = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

export default defineConfig({
    test: {
        include: ["test/integration/**/*.test.ts"],
        fileParallelism: false,
        globalSetup: ["./test/integration/global-setup.ts"],
        testTimeout: 30_000,
        env: {
            TESTING: "true",
            GITHUB_APP_ID: "test",
            GITHUB_PRIVATE_KEY: Buffer.from(throwawayPrivateKey).toString("base64"),
            PREVIEW_URL_SECRET: "test-preview-url-secret",
        },
    },
});
