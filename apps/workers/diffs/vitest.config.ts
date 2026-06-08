import { join } from "node:path";
import { config } from "dotenv";
import { defineConfig } from "vitest/config";

// Eval files (`evals/**/*.eval.ts`) are only collected when RUN_EVALS=true, so
// `pnpm test` stays fast and DB/credential-free while `pnpm eval` runs the
// scored, network-touching evaluations.
const includeEvals = process.env.RUN_EVALS === "true";

export default defineConfig({
    test: {
        include: ["src/**/*.test.ts", "test/**/*.test.ts", ...(includeEvals ? ["evals/**/*.eval.ts"] : [])],
        exclude: ["**/dist/**", "**/node_modules/**"],
        env: { ...config({ path: join(__dirname, "../../../.env") }).parsed },
        watch: false,
        // Eval suites share one on-disk repo cache via `ensureCachedCheckout`; running
        // two suites in parallel processes would race on `.git/index.lock`. Force
        // single-file execution when collecting evals so cross-suite ordering matches
        // the existing within-suite `parallel: false` invariant. Unit tests are
        // unaffected (`RUN_EVALS` defaults to off).
        ...(includeEvals ? { fileParallelism: false } : {}),
    },
});
