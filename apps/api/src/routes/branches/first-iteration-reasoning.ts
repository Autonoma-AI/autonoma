import type { PrismaClient } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";

/**
 * The reasoning shown in the snapshot report and the diffs timeline is the
 * reasoning of iteration 1 of the snapshot's refinement loop. A snapshot has at
 * most one refinement loop, and a loop has at most one iteration numbered 1, so
 * a single lookup is unambiguous.
 *
 * Returns undefined when the snapshot has no loop, or iteration 1 has not yet
 * written its reasoning (still pending/running, or errored before finishing).
 */
export async function loadFirstIterationReasoning(
    db: PrismaClient,
    snapshotId: string,
    parentLogger?: Logger,
): Promise<string | undefined> {
    const logger = (parentLogger ?? rootLogger).child({ name: "loadFirstIterationReasoning", snapshotId });

    const iteration = await db.refinementIteration.findFirst({
        where: { loop: { snapshotId }, number: 1 },
        select: { reasoning: true },
    });

    logger.info("Loaded first iteration reasoning", { hasReasoning: iteration?.reasoning != null });
    return iteration?.reasoning ?? undefined;
}
