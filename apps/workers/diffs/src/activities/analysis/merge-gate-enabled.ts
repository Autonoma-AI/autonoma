import { db } from "@autonoma/db";
import { env } from "../../env";

/**
 * Whether the merge gate is effectively live for an org: the global `MERGE_GATE_ENABLED` switch AND the org's
 * opt-in.
 */
export async function isMergeGateEnabledForOrg(organizationId: string): Promise<boolean> {
    if (!env.MERGE_GATE_ENABLED) return false;
    const settings = await db.organizationSettings.findUnique({
        where: { organizationId },
        select: { mergeGateEnabled: true },
    });
    return settings?.mergeGateEnabled === true;
}
