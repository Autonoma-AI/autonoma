import { join } from "node:path";
import { config } from "dotenv";
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // Unit/integration tests only. Live-model evals live in evals/ and are deliberately excluded
        // here so they never run as part of `pnpm test` (turbo) - they make real, paid, non-deterministic
        // API calls. Run them on demand with `pnpm eval` (see vitest.eval.config.ts).
        include: ["tests/**/*.test.ts"],
        exclude: ["**/dist/**", "**/node_modules/**"],
        watch: false,
        env: { ...config({ path: join(__dirname, "../../.env") }).parsed },
    },
});
