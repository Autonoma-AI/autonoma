import { join } from "node:path";
import { config } from "dotenv";
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // Only the suites that need containers. `test/unit/**` is vitest.config.ts's include, so
        // globbing all of test/ here ran every unit file a second time - in the slowest place to
        // run it, behind this config's globalSetup.
        include: ["test/integration/**/*.test.ts", "test/onboarding/**/*.test.ts"],
        globalSetup: ["./test/global-setup.ts"],
        testTimeout: 15000,
        env: {
            // Defaults for required env vars - overridden by .env locally and by test harness at runtime
            API_PORT: "4000",
            SCENARIO_ENCRYPTION_KEY: "a".repeat(64),
            GOOGLE_CLIENT_ID: "test",
            GOOGLE_CLIENT_SECRET: "test",
            REDIS_URL: "redis://localhost:6379",
            MERGE_GATE_ENABLED: "true",
            // GitHub App: tests run against the fake (LOCAL_DEV=true). Real credentials
            // are unnecessary; passing them as base64 PEM is awkward in test fixtures.
            LOCAL_DEV: "true",
            BETTER_AUTH_SECRET: "test-secret",
            // Needed to build absolute links (packages/types app-links). Previously only ever
            // present via a developer's .env below, so the suite passed locally and threw
            // "Invalid URL" anywhere without one - which nothing noticed while it never ran in CI.
            APP_URL: "https://autonoma.app",
            ...config({ path: join(__dirname, "../../.env") }).parsed,
            TESTING: "true",
            SENTRY_ENV: "test",
            NAMESPACE: "test",
        },
    },
});
