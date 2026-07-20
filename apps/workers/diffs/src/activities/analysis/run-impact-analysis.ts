import { db } from "@autonoma/db";
import { assertSnapshotPending } from "@autonoma/diffs/analysis";
import { logger as rootLogger } from "@autonoma/logger";
import type { RunImpactAnalysisInput, RunImpactAnalysisOutput } from "@autonoma/workflow/activities";
import { selectImpactTargets } from "../../analysis/impact-analysis";
import { withCodebaseForSnapshot } from "../../codebase/resolve";

/**
 * Impact Analysis stage. Fails fast unless the snapshot is `processing` (later stages read its frozen baseline
 * and stage edits onto it via SnapshotDraft, which requires `processing`) - the branch's real pending snapshot.
 * Then reuses the DiffsAgent to select the tests the PR's diff affects and author brand-new ones, materializing
 * each through the canonical update actions (see `selectImpactTargets`). Hands the resulting targets to the
 * Investigator fan-out and returns the agent's selection reasoning for the report.
 */
export async function runImpactAnalysis(input: RunImpactAnalysisInput): Promise<RunImpactAnalysisOutput> {
    const { snapshotId } = input;
    // snapshotId (+ the snapshot graph) is bound to the observability context by the activity interceptor, so it
    // lands on every log automatically.
    const logger = rootLogger.child({ name: "runImpactAnalysis" });
    logger.info("Impact Analysis stage started");

    // The whole pipeline assumes a still-pending (`processing`) snapshot. Assert it up front so a misrouted active
    // snapshot fails immediately rather than deep in the clone + agent run.
    await assertSnapshotPending(db, snapshotId);

    const selection = await withCodebaseForSnapshot(snapshotId, {
        targetDirSeed: `impact-${snapshotId}`,
        body: (codebase) => selectImpactTargets({ snapshotId, codebase }),
    });

    logger.info("Impact Analysis stage finished", { extra: { targetCount: selection.targets.length } });
    return { targets: selection.targets, reasoning: selection.reasoning };
}
