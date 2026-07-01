import { join } from "node:path";
import { config } from "dotenv";
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["test/**/*.test.ts"],
        exclude: ["**/dist/**", "**/node_modules/**"],
        // TESTING=true makes packages/db/src/env.ts skip its DATABASE_URL validation at
        // import (createClient/applyMigrations take an explicit connection string instead).
        env: { ...config({ path: join(__dirname, "../../.env") }).parsed, TESTING: "true" },
        watch: false,
    },
});
