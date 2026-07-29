import { join } from "node:path";
import { config } from "dotenv";
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["test/**/*.test.ts"],
        // The kind-backed suite (real cluster, Docker required) runs separately
        // via `test:integration`; keep the default `test` run fast and hermetic.
        exclude: ["test/integration/**", "node_modules/**"],
        env: { ...config({ path: join(__dirname, "../../.env") }).parsed },
    },
});
