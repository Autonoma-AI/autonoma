import { db } from "@autonoma/db";
import { assertSnapshotPending } from "@autonoma/diffs/analysis";
import { logger as rootLogger } from "@autonoma/logger";
import type { RunImpactAnalysisInput, RunImpactAnalysisOutput } from "@autonoma/workflow/activities";
import { selectImpactTargets } from "../../analysis/impact-analysis";
import { withCodebaseForSnapshot } from "../../codebase/resolve";

/**
 * Impact Analysis stage. Fails fast unless the snapshot is a `processing` detached snapshot (later stages read
 * its frozen baseline), then reuses the DiffsAgent to select the tests the PR's diff affects and author brand-new
 * ones, materializing each through the canonical update actions on the job's own detached snapshot (see
 * `selectImpactTargets`). Hands the resulting targets to the Investigator fan-out.
 */
export async function runImpactAnalysis(input: RunImpactAnalysisInput): Promise<RunImpactAnalysisOutput> {
    const { snapshotId, mode } = input;
    // snapshotId (+ the snapshot graph) is bound to the observability context by the activity interceptor, so it
    // lands on every log automatically; only the non-canonical `mode` goes in `extra`.
    const logger = rootLogger.child({ name: "runImpactAnalysis", extra: { mode } });
    logger.info("Impact Analysis stage started");

    // The whole pipeline assumes a detached, still-pending snapshot. Assert it up front so a misrouted active
    // snapshot fails immediately rather than deep in the clone + agent run.
    await assertSnapshotPending(db, snapshotId);

    const targets = await withCodebaseForSnapshot(snapshotId, {
        targetDirSeed: `impact-${snapshotId}`,
        body: (codebase) => selectImpactTargets({ snapshotId, codebase }),
    });

    logger.info("Impact Analysis stage finished", { extra: { targetCount: targets.length } });
    return { targets };
}
