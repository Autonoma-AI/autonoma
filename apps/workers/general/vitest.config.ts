import { join } from "node:path";
import { config } from "dotenv";
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["src/**/*.test.ts", "test/**/*.test.ts"],
        exclude: ["**/dist/**", "**/node_modules/**"],
        // TESTING=true makes packages/db/src/env.ts skip its DATABASE_URL validation at
        // import (createClient/applyMigrations take an explicit connection string instead);
        // the integration tests then point the global db at a container.
        env: { ...config({ path: join(__dirname, "../../../.env") }).parsed, TESTING: "true" },
        watch: false,
    },
});
