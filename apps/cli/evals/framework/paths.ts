import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every filesystem location the eval harness uses, in one place.
 *
 * The corpus (`cases/`) is committed but stripped from the public mirror via
 * `.opensource-ignore`; the repo cache and per-run outputs are gitignored. The
 * cached client checkout is the answer key (it holds the golden integration at
 * `sha`), so it MUST NOT be exposed to the driven subinstance during a run - only
 * the sandbox is. See `run.ts` for how the sandbox is derived without mutating
 * the cache.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** `apps/cli/evals/` */
export const EVALS_ROOT = resolve(HERE, "..");

/** Shared per-repo corpus. Opensource-ignored (holds client IP). */
export const CASES_DIR = join(EVALS_ROOT, "cases");

/** Clone-once repo cache, keyed by `owner__repo`. Gitignored. */
export const CACHE_DIR = join(EVALS_ROOT, ".cache", "repos");

/** Per-run outputs (sandbox, judge trees, transcripts, verdict). Gitignored. */
export const RUNS_DIR = join(EVALS_ROOT, ".runs");

/** `cases/<repo>/` - repo coords, strip patch, frozen artifacts, context, rubrics. */
export function caseDir(repo: string): string {
    return join(CASES_DIR, repo);
}

/** `cases/<repo>/artifacts/` - the frozen planner-artifact set fed to the agent. */
export function artifactsDir(repo: string): string {
    return join(caseDir(repo), "artifacts");
}

/** Cache dir for a repo's checkout. This is the pristine `sha` tree (= golden). */
export function repoCacheDir(owner: string, repo: string): string {
    return join(CACHE_DIR, `${owner}__${repo}`);
}

/** `.runs/<repo>/<stamp>/` - everything a single run produces. */
export function runDir(repo: string, stamp: string): string {
    return join(RUNS_DIR, repo, stamp);
}
