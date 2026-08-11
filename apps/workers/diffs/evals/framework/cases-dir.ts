import path from "node:path";
import { fileURLToPath } from "node:url";

/** `apps/workers/diffs/evals/` */
const EVALS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * On-disk cases directory for an eval `suite` (e.g. `"classifier"`):
 * `evals/cases/<suite>`.
 *
 * The corpus is committed alongside the harness and stripped from the public
 * mirror through `.opensource-ignore` (see `evals/README.md`), so both the eval
 * suites and the capture commands resolve the same in-tree path. Every suite's
 * cases sit under one `cases/` root so that strip rule is a single directory.
 */
export function casesDir(suite: string): string {
    return path.join(EVALS_ROOT, "cases", suite);
}
