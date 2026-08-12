import { logger as rootLogger } from "@autonoma/logger";
import type {
    PersistAnalysisClassificationInput,
    PersistAnalysisClassificationOutput,
} from "@autonoma/workflow/activities";
import { getAnalysisStore } from "../../services";

/**
 * File one run+classify iteration onto the analysis store: the Investigator calls this after EVERY iteration, so
 * a self-heal's superseded verdict stays on disk instead of being overwritten by the pass that follows it. The
 * store appends by the caller's iteration counter, which is what makes re-filing a slot restate rather than
 * duplicate it. See {@link Analysis.recordClassification} for the invariants.
 */
export async function persistAnalysisClassification(
    input: PersistAnalysisClassificationInput,
): Promise<PersistAnalysisClassificationOutput> {
    const { snapshotId, testCaseId, origin, selectionReason, number, classification } = input;
    // snapshotId is bound to the observability context by the activity interceptor; only the non-canonical
    // testCase/category go in `extra`.
    const logger = rootLogger.child({
        name: "persistAnalysisClassification",
        extra: { testCaseId, number, category: classification.category },
    });
    logger.info("Persisting analysis classification");

    const scope = getAnalysisStore().forAnalysis(snapshotId);
    const { findingId } = await scope.recordClassification({
        testCaseId,
        origin,
        selectionReason,
        number,
        generationId: classification.generationId,
        category: classification.category,
        headline: classification.headline,
        report: classification.report,
    });

    logger.info("Persisted analysis classification");
    return { findingId, number };
}
