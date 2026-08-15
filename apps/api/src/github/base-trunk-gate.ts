import type { PrismaClient } from "@autonoma/db";

/**
 * Whether the base-trunk analysis gate is enforced for this organization. Off by default: until an org opts in, a
 * PR against ANY base is analyzed, so the gate never silently drops analysis for a repo whose PRs merge into a
 * non-trunk branch (a stack, or an internal integration branch). Read by both analysis-trigger paths (the diffs
 * `/trigger` path and the previewkit webhook path) so the two can't disagree on when the gate applies.
 */
export async function isBaseTrunkGateEnforced(
    db: Pick<PrismaClient, "organizationSettings">,
    organizationId: string,
): Promise<boolean> {
    const settings = await db.organizationSettings.findUnique({
        where: { organizationId },
        select: { enforceBaseTrunkGate: true },
    });
    return settings?.enforceBaseTrunkGate === true;
}
