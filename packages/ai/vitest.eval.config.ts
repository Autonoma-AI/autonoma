import { join } from "node:path";
import { config } from "dotenv";
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // Live-model tests only: real, paid, non-deterministic API calls that need API keys. Run on
        // demand via `pnpm eval`, never as part of `pnpm test` (which uses vitest.config.ts and is
        // scoped to deterministic units). Covers the scored evals under evals/ and the
        // `*.live.test.ts` integration tests under tests/.
        include: ["evals/**/*.test.ts", "tests/**/*.live.test.ts"],
        exclude: ["**/dist/**", "**/node_modules/**"],
        watch: false,
        env: { ...config({ path: join(__dirname, "../../.env") }).parsed },
    },
});
