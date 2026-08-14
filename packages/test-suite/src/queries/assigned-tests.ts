import type { PrismaClient } from "@autonoma/db";

/**
 * Counts the tests assigned to each snapshot - the "of N tests" denominator shown on the PR list and the
 * pull-request page.
 *
 * One grouped query for the whole set, never a nested `_count` on a list query. Prisma compiles a nested relation
 * `_count` into per-row aggregate work: on an application with ~300 open pull requests that turned the PR-list
 * query from 250ms into 1.3s, for a number this returns in ~90ms. The rows themselves must not be fetched either
 * - the same list was pulling 10k assignment rows across the page purely to take their length.
 */
export async function countTestsBySnapshot(db: PrismaClient, snapshotIds: string[]): Promise<Map<string, number>> {
    if (snapshotIds.length === 0) return new Map();

    const groups = await db.testCaseAssignment.groupBy({
        by: ["snapshotId"],
        where: { snapshotId: { in: snapshotIds } },
        _count: { _all: true },
    });

    return new Map(groups.map((group) => [group.snapshotId, group._count._all]));
}
