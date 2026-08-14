import type { Codebase, EvidenceLoader } from "@autonoma/diffs";
import type { RunCaseHelpers } from "@autonoma/evals";
import type { Logger } from "@autonoma/logger";
import { type CodebaseCoords, UnfetchableShaError, ensureCachedCheckout } from "./codebase-cache";
import { type EvidenceKeys, MissingEvidenceError, probeEvidence } from "./evidence-probe";

/**
 * The skip-or-rethrow policy every scored-replay eval shares over a captured case's stale inputs.
 *
 * A capture freezes a codebase SHA and a set of S3 keys; either can rot before the case is next replayed (a commit
 * GC'd, an object rotated away). That is a stale case, NOT a failed one - failing the suite over it would punish
 * an unrelated change - so the harness skips it with a warning and lets any other error propagate. Both halves
 * live here rather than pasted into every `Evaluation` subclass: the framework already owns the primitives they
 * wrap (`ensureCachedCheckout`, `probeEvidence` and their typed errors), so the policy that decides skip-vs-throw
 * belongs beside them, not in each caller.
 */

/** Which case is being set up, for the skip log line. */
export interface CaseSkipContext {
    logger: Logger;
    caseName: string;
}

/**
 * Check out the case's codebase, or skip the case if its SHA can no longer be fetched. Returns the checked-out
 * {@link Codebase} on success; an {@link UnfetchableShaError} becomes a `helpers.skip`, anything else rethrows.
 */
export async function rehydrateOrSkip(
    coords: CodebaseCoords,
    helpers: RunCaseHelpers,
    ctx: CaseSkipContext,
): Promise<Codebase> {
    try {
        return await ensureCachedCheckout(coords);
    } catch (err) {
        if (err instanceof UnfetchableShaError) {
            ctx.logger.warn("Skipping case: codebase no longer fetchable", {
                extra: { case: ctx.caseName, sha: err.sha, repo: err.repoFullName },
            });
            helpers.skip(`codebase unfetchable: ${err.message}`);
        }
        throw err;
    }
}

/**
 * Probe every S3 key a case references, or skip the case if any has rotated away. The caller collects its own key
 * set (the one part that varies per step - which frames a finding or a run trace offers); this owns the pre-flight
 * probe + skip. A {@link MissingEvidenceError} becomes a `helpers.skip`, anything else rethrows.
 */
export async function skipIfEvidenceUnreachable(
    keys: EvidenceKeys,
    loader: EvidenceLoader,
    helpers: RunCaseHelpers,
    ctx: CaseSkipContext,
): Promise<void> {
    try {
        await probeEvidence(keys, loader, { logger: ctx.logger });
    } catch (err) {
        if (err instanceof MissingEvidenceError) {
            ctx.logger.warn("Skipping case: evidence no longer reachable", {
                extra: { case: ctx.caseName, key: err.key, kind: err.kind },
            });
            helpers.skip(`evidence unreachable: ${err.message}`);
        }
        throw err;
    }
}
