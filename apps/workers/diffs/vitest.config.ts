import { join } from "node:path";
import { config } from "dotenv";
import { defineConfig } from "vitest/config";

// Eval files (`evals/**/*.eval.ts`) are only collected when RUN_EVALS=true, so
// `pnpm test` stays fast and DB/credential-free while `pnpm eval` runs the
// scored, network-touching evaluations.
const includeEvals = process.env.RUN_EVALS === "true";

// Cap on how many eval cases run concurrently (`test.concurrent`, each in its own git worktree). Set
// below the corpus size on purpose: the per-case model fan-out - heaviest being the video uploads -
// trips provider rate limits and aborts near full width, so this trades some wall-clock for a pass
// rate that reflects the models rather than throttling. Raise it for a provider tier that tolerates
// more; lower it if you still see 429s or aborted generations.
const EVAL_MAX_CONCURRENCY = 8;

export default defineConfig({
    test: {
        include: ["src/**/*.test.ts", "test/**/*.test.ts", ...(includeEvals ? ["evals/**/*.eval.ts"] : [])],
        exclude: ["**/dist/**", "**/node_modules/**"],
        globalSetup: ["./test/global-setup.ts"],
        // TESTING=true makes packages/db/src/env.ts skip its DATABASE_URL validation at
        // import (createClient/applyMigrations take an explicit connection string instead).
        env: { ...config({ path: join(__dirname, "../../../.env") }).parsed, TESTING: "true" },
        watch: false,
        // Per-case worktrees make within-suite concurrency safe, but the suites still run one file
        // at a time: `fileParallelism: false` keeps only one suite's model burst in flight, and the
        // analysis and reporter suites are a single case each so overlapping the files buys nothing.
        // Unit tests are unaffected (`RUN_EVALS` defaults to off).
        ...(includeEvals ? { fileParallelism: false, maxConcurrency: EVAL_MAX_CONCURRENCY } : {}),
    },
});
