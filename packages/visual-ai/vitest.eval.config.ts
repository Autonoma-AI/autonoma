import { join } from "node:path";
import { config } from "dotenv";
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // Live-model tests only: real, paid, non-deterministic API calls that need API keys. Run on
        // demand via `pnpm eval`, never as part of `pnpm test` (which uses vitest.config.ts). Covers
        // the scored visual/detection evals under evals/.
        include: ["evals/**/*.test.ts", "tests/**/*.live.test.ts"],
        exclude: ["**/dist/**", "**/node_modules/**"],
        watch: false,
        env: { ...config({ path: join(__dirname, "../../.env") }).parsed },
    },
});
