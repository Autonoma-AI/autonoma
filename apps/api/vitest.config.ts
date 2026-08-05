import { join } from "node:path";
import { config } from "dotenv";
import { defineConfig } from "vitest/config";

/**
 * Stand-ins for the variables `createEnv` requires and cannot default, so a unit test can
 * import server code without a `.env` on the machine.
 *
 * Without these a test passes for anyone who has run the app locally and fails in CI, which
 * reads as "your change broke a test" rather than "this test needs a file CI does not have".
 * Values are placeholders and must stay obviously fake: a unit test that behaves differently
 * because of what is in here is reaching for something it should be given explicitly.
 */
const REQUIRED_ENV_STAND_INS = {
    API_PORT: "4000",
    SCENARIO_ENCRYPTION_KEY: "0".repeat(64),
    GOOGLE_CLIENT_ID: "test-google-client-id",
    GOOGLE_CLIENT_SECRET: "test-google-client-secret",
    GEMINI_API_KEY: "test-gemini-api-key",
    REDIS_URL: "redis://127.0.0.1:6379",
};

export default defineConfig({
    test: {
        include: ["test/unit/**/*.test.ts"],
        // A real `.env` wins, so running against local configuration is unchanged.
        env: {
            ...REQUIRED_ENV_STAND_INS,
            ...config({ path: join(__dirname, "../../.env") }).parsed,
            TESTING: "true",
        },
    },
});
