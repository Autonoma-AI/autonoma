import { logger as rootLogger } from "@autonoma/logger";
import type { RecordAnalysisContainmentInput, RecordAnalysisContainmentOutput } from "@autonoma/workflow/activities";
import { getAnalysisStore } from "../../services";

/**
 * Record a crashed Investigator child onto its test's finding as a structured `failure`. Called by the fan-out
 * parent - the only place a child's death is observed. The finding is created when the child never filed
 * anything, and it gets NO classification: "contained" is derived from a finding with a failure and zero
 * classifications, and an iteration the child did file before dying keeps being the verdict the run stands
 * behind.
 */
export async function recordAnalysisContainment(
    input: RecordAnalysisContainmentInput,
): Promise<RecordAnalysisContainmentOutput> {
    const { snapshotId, testCaseId, origin, selectionReason, message } = input;
    const logger = rootLogger.child({ name: "recordAnalysisContainment", extra: { testCaseId } });
    logger.warn("Recording a crashed Investigator's containment", { extra: { message } });

    const scope = getAnalysisStore().forAnalysis(snapshotId);
    const { findingId } = await scope.recordContainment({
        testCaseId,
        origin,
        selectionReason,
        failure: { kind: "investigator_crashed", message },
    });

    logger.info("Recorded the containment", { extra: { findingId } });
    return { findingId };
}
