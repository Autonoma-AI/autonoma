import { join } from "node:path";
import { config } from "dotenv";
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["test/**/*.test.ts"],
        fileParallelism: false,
        globalSetup: ["./test/global-setup.ts"],
        env: {
            // Defaults for required env vars - overridden by .env locally and by test harness at runtime
            API_PORT: "4000",
            SCENARIO_ENCRYPTION_KEY: "a".repeat(64),
            GOOGLE_CLIENT_ID: "test",
            GOOGLE_CLIENT_SECRET: "test",
            GEMINI_API_KEY: "test",
            REDIS_URL: "redis://localhost:6379",
            GITHUB_APP_ID: "test",
            GITHUB_APP_PRIVATE_KEY: "test",
            GITHUB_APP_WEBHOOK_SECRET: "test",
            GITHUB_APP_SLUG: "test",
            BETTER_AUTH_SECRET: "test-secret",
            ...config({ path: join(__dirname, "../../.env") }).parsed,
            TESTING: "true",
            SENTRY_ENV: "test",
            NAMESPACE: "test",
        },
    },
});
