import { db } from "@autonoma/db";
import { env } from "../../env";

/**
 * Whether the merge gate is effectively live for an org: the global `MERGE_GATE_ENABLED` switch AND the org's
 * opt-in AND `analysisEnabled` (the gate reads the authoritative verdict).
 */
export async function isMergeGateEnabledForOrg(organizationId: string): Promise<boolean> {
    if (!env.MERGE_GATE_ENABLED) return false;
    const settings = await db.organizationSettings.findUnique({
        where: { organizationId },
        select: { mergeGateEnabled: true, analysisEnabled: true },
    });
    return settings?.mergeGateEnabled === true && settings.analysisEnabled === true;
}
