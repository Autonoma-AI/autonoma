import { join } from "node:path";
import { config } from "dotenv";
import { defineConfig } from "vitest/config";

const includeEvals = process.env.RUN_EVALS === "true";

export default defineConfig({
    test: {
        include: ["src/**/*.test.ts", "test/**/*.test.ts", ...(includeEvals ? ["evals/**/*.eval.ts"] : [])],
        exclude: ["**/dist/**", "**/node_modules/**"],
        watch: false,
        env: { ...config({ path: join(__dirname, "../../.env") }).parsed },
        ...(includeEvals ? { fileParallelism: false } : {}),
    },
});
