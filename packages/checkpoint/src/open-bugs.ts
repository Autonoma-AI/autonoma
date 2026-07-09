import { Prisma, type PrismaClient } from "@autonoma/db";
import { z } from "zod";

const openBugCountRowSchema = z.object({
    snapshot_id: z.string(),
    count: z.number().int().nonnegative(),
});

/**
 * Counts unique open application bugs per snapshot. A bug is attributed to a
 * snapshot when one of its issues is linked (via a generation review) to that
 * snapshot. The `COUNT(DISTINCT bug_id)` is pushed down to SQL so a bug
 * surfacing across multiple reviews counts once without deduplicating in memory.
 *
 * This is the single source of truth for the open-bug count shown on the PR
 * list, the snapshot report, and the GitHub PR comment.
 */
export async function countOpenBugsBySnapshot(db: PrismaClient, snapshotIds: string[]): Promise<Map<string, number>> {
    if (snapshotIds.length === 0) return new Map();

    // A bug reaches a snapshot through its generation review; count distinct bug
    // ids per snapshot.
    const rows = await db.$queryRaw(Prisma.sql`
        SELECT snapshot_id, COUNT(DISTINCT bug_id)::int AS count
        FROM (
            SELECT i.bug_id, g.snapshot_id
            FROM issue i
            JOIN generation_review gr ON gr.id = i.review_id
            JOIN test_generation g ON g.id = gr.generation_id
            JOIN bug b ON b.id = i.bug_id
            WHERE b.status = 'open' AND g.snapshot_id IN (${Prisma.join(snapshotIds)})
        ) linked
        GROUP BY snapshot_id
    `);

    const parsed = openBugCountRowSchema.array().parse(rows);
    return new Map(parsed.map((row) => [row.snapshot_id, row.count]));
}
