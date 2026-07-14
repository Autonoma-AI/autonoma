import { join } from "node:path";
import { config } from "dotenv";
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // Deterministic, key-free unit/integration tests only. The scored evals under evals/ make
        // real, paid, non-deterministic model calls and are deliberately excluded so `pnpm test`
        // (turbo, CI) never needs API keys. Run the evals on demand with `pnpm eval` (see
        // vitest.eval.config.ts). This package currently has no deterministic units, so
        // passWithNoTests keeps `pnpm test` green.
        include: ["tests/**/*.test.ts"],
        exclude: ["**/dist/**", "**/node_modules/**", "**/*.live.test.ts"],
        passWithNoTests: true,
        watch: false,
        env: { ...config({ path: join(__dirname, "../../.env") }).parsed },
    },
});
