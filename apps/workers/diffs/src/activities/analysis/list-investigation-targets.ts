import { logger as rootLogger } from "@autonoma/logger";
import { analysisTestOriginSchema } from "@autonoma/types";
import type { AnalysisInvestigationTarget, ListInvestigationTargetsInput } from "@autonoma/workflow/activities";
import { getAnalysisStore } from "../../services";

/**
 * The run's investigation targets, read from the findings Impact Analysis created at selection. Fan-out reads the
 * selection back from the DB rather than receiving it from the impact stage, so the two stages share no workflow
 * payload and a target set survives a workflow replay.
 */
export async function listInvestigationTargets(
    input: ListInvestigationTargetsInput,
): Promise<AnalysisInvestigationTarget[]> {
    const { snapshotId } = input;
    const logger = rootLogger.child({ name: "listInvestigationTargets" });
    logger.info("Listing investigation targets");

    const selection = await getAnalysisStore().forAnalysis(snapshotId).selectionTargets();
    const targets = selection.map((entry) => ({
        slug: entry.slug,
        testCaseId: entry.testCaseId,
        reason: entry.selectionReason ?? "",
        // Origin is set on every finding at selection; a malformed value falls back to the common case rather than
        // dropping the test from the fan-out.
        origin: analysisTestOriginSchema.safeParse(entry.origin).data ?? "pre_existing",
    }));

    logger.info("Listed investigation targets", { extra: { count: targets.length } });
    return targets;
}
