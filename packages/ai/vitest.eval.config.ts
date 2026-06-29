import { join } from "node:path";
import { config } from "dotenv";
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // Live-model evals only: real, paid, non-deterministic API calls. Run on demand via `pnpm eval`,
        // never as part of `pnpm test` (which uses vitest.config.ts and is scoped to tests/).
        include: ["evals/**/*.test.ts"],
        exclude: ["**/dist/**", "**/node_modules/**"],
        watch: false,
        env: { ...config({ path: join(__dirname, "../../.env") }).parsed },
    },
});
