import type { Prisma, PrismaClient } from "@autonoma/db";

/** One test the run selected to investigate, read back from its finding. Slug-ordered. */
export interface SelectionTarget {
    slug: string;
    testCaseId: string;
    origin?: string;
    selectionReason?: string;
}

/** The run's selection - one entry per finding created at selection - read from `analysis_finding`. */
export async function readSelectionTargets(
    db: PrismaClient | Prisma.TransactionClient,
    snapshotId: string,
): Promise<SelectionTarget[]> {
    const rows = await db.analysisFinding.findMany({
        where: { reportSnapshotId: snapshotId },
        orderBy: { testCase: { slug: "asc" } },
        select: { testCaseId: true, origin: true, selectionReason: true, testCase: { select: { slug: true } } },
    });
    return rows.map((row) => ({
        slug: row.testCase.slug,
        testCaseId: row.testCaseId,
        origin: row.origin ?? undefined,
        selectionReason: row.selectionReason ?? undefined,
    }));
}
