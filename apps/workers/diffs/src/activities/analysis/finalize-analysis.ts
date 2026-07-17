import { logger as rootLogger } from "@autonoma/logger";
import type { FinalizeAnalysisInput, FinalizeAnalysisOutput } from "@autonoma/workflow/activities";

/**
 * finalize stage - workflow plumbing. Promotion (activating the twin as the branch's suite) happens only in
 * authoritative mode, which stays dormant until the cutover ships. In shadow mode this is the complete, correct
 * behavior: the detached twin is never promoted, so the run leaves production untouched.
 */
export async function finalizeAnalysis(input: FinalizeAnalysisInput): Promise<FinalizeAnalysisOutput> {
    const { mode } = input;
    // snapshotId is bound to the observability context by the activity interceptor; only non-canonical `mode`
    // goes in `extra`. (The real promotion will use input.snapshotId.)
    const logger = rootLogger.child({ name: "finalizeAnalysis", extra: { mode } });
    logger.info("finalize stage started");

    if (mode === "authoritative") {
        // Promotion stays dormant until the authoritative cutover ships; log so an accidental authoritative run is visible.
        logger.warn("Authoritative finalize (promotion) is not implemented yet; leaving the snapshot detached");
    }

    logger.info("finalize stage finished; snapshot not promoted");
    return { promoted: false };
}
