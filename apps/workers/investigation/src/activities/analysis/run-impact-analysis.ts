import { db } from "@autonoma/db";
import { assertSnapshotPending } from "@autonoma/investigation";
import { logger as rootLogger } from "@autonoma/logger";
import type { RunImpactAnalysisInput, RunImpactAnalysisOutput } from "@autonoma/workflow/activities";

/**
 * Impact Analysis stage (stub). The real stage will select diff-affected tests and materialize new ones; for
 * now it only fails fast unless the twin is a `processing` detached snapshot - mirroring the investigation
 * agent's precondition - and returns no targets so the shadow run completes end-to-end without doing real work.
 */
export async function runImpactAnalysis(input: RunImpactAnalysisInput): Promise<RunImpactAnalysisOutput> {
    const { snapshotId, mode } = input;
    // snapshotId (+ the snapshot graph) is bound to the observability context by the activity interceptor, so
    // it lands on every log automatically; only the non-canonical `mode` goes in `extra`.
    const logger = rootLogger.child({ name: "runImpactAnalysis", extra: { mode } });
    logger.info("Impact Analysis stage started (stub)");

    // The whole pipeline assumes a detached, still-pending twin (later stages read its frozen baseline). Assert
    // it up front so a misrouted active snapshot fails immediately rather than deep in a later stage.
    await assertSnapshotPending(db, snapshotId);

    logger.info("Impact Analysis stage finished (stub); no targets selected");
    return { targets: [] };
}
