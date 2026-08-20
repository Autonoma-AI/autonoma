import { type PrismaClient, TriggerSource } from "@autonoma/db";

/**
 * Keyed to the oldest trigger-created snapshot rather than to a job row: keying it to `AnalysisJob` would reset
 * every pre-cutover customer's clock, since only post-cutover runs have one. `MANUAL` is excluded because those
 * snapshots are not runs - one is minted at application setup and one per suite edit in the UI, so including them
 * would start the age clock at signup and make `hasEverRun` true for every application that exists.
 */
export async function firstRunAt(
    db: PrismaClient,
    applicationId: string,
    organizationId: string,
): Promise<Date | undefined> {
    const oldest = await db.branchSnapshot.findFirst({
        where: { branch: { applicationId, organizationId }, source: { not: TriggerSource.MANUAL } },
        select: { createdAt: true },
        orderBy: { createdAt: "asc" },
    });
    return oldest?.createdAt;
}
