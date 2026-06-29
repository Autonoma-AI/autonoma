import { join } from "node:path";
import { config } from "dotenv";
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // Deterministic, key-free unit/integration tests only. Two kinds of live-model tests (real,
        // paid, non-deterministic API calls) are deliberately excluded so `pnpm test` (turbo, CI)
        // never needs API keys: the scored evals under evals/, and the `*.live.test.ts` integration
        // tests that sit alongside the unit tests in tests/. Run both on demand with `pnpm eval`
        // (see vitest.eval.config.ts).
        include: ["tests/**/*.test.ts"],
        exclude: ["**/dist/**", "**/node_modules/**", "**/*.live.test.ts"],
        watch: false,
        env: { ...config({ path: join(__dirname, "../../.env") }).parsed },
    },
});
