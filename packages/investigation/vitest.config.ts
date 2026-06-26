import { join } from "node:path";
import { config } from "dotenv";
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["test/**/*.test.ts"],
        exclude: ["**/dist/**", "**/node_modules/**"],
        // TESTING=true makes @autonoma/db skip env validation; the DB client is the Testcontainers one.
        env: { ...config({ path: join(__dirname, "../../.env") }).parsed, TESTING: "true" },
        watch: false,
        // Testcontainers needs time to pull/start Postgres + apply migrations.
        testTimeout: 120_000,
        hookTimeout: 180_000,
    },
});
