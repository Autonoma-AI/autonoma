import { configDefaults, defineConfig } from "vitest/config";

/**
 * Eval runs cut a git worktree of a customer's repo into `evals/.runs/`. Those
 * checkouts carry their own test suites, and vitest's default discovery collects
 * them as if they were ours - a single leftover sandbox turned a green run into
 * 720 failing files. The directory is gitignored, so nothing here is ours to run.
 */
export default defineConfig({
    test: {
        exclude: [...configDefaults.exclude, "evals/.runs/**"],
    },
});
