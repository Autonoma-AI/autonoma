import { join } from "node:path";
import { config } from "dotenv";
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["test/**/*.test.ts"],
        // The kind-backed suite (real cluster, Docker required) runs separately
        // via `test:integration`; keep the default `test` run fast and hermetic.
        exclude: ["test/integration/**", "node_modules/**"],
        // TESTING skips every `createEnv` in the import graph, as the integration config does. Without it a
        // suite reaching an env module passes off a developer's `.env` and fails in CI, which has none.
        env: { ...config({ path: join(__dirname, "../../.env") }).parsed, TESTING: "true" },
    },
});
