import type { PrismaClient } from "@autonoma/db";

export async function loadPreviouslyQuarantinedTestCaseIds(
    db: PrismaClient,
    prevSnapshotId: string | null,
): Promise<Set<string>> {
    if (prevSnapshotId == null) return new Set();
    const rows = await db.testCaseAssignment.findMany({
        where: { snapshotId: prevSnapshotId, quarantineIssueId: { not: null } },
        select: { testCaseId: true },
    });
    return new Set(rows.map((r) => r.testCaseId));
}
