import type { PrismaClient } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";

export interface PinnedSourceForClassifier {
    snapshotId: string;
    branchName: string;
    prNumber: number;
    /**
     * Snapshot that plays the role of the 3-way merge-base for this source.
     * Resolved from `branch.baseSnapshotId` (with fallback to
     * `activeSnapshot.prevSnapshotId`) in `findMergeSourceSnapshot`. When null,
     * the source cannot contribute a merge-base leg and the per-test base is
     * treated as absent for this source.
     */
    baseSnapshotId: string | null;
}

export interface ClassifierInputAssignment {
    assignmentId: string;
    planId: string | null;
}

export interface ClassifierInputRow {
    slug: string;
    testName: string;
    target: ClassifierInputAssignment | null;
    sources: Array<{
        sourceName: string;
        prNumber: number;
        leg: ClassifierInputAssignment | null;
        base: ClassifierInputAssignment | null;
    }>;
}

export interface BuildMergeClassifierInputsParams {
    db: PrismaClient;
    targetSnapshotId: string;
    sources: PinnedSourceForClassifier[];
}

/**
 * Assembles per-test input rows for `classifyTestsForMerge` by reading test
 * case assignments from the target snapshot (current main), each pinned
 * source snapshot, and the source branch's merge-base snapshot (resolved via
 * `branch.baseSnapshotId`, with the same prev-snapshot fallback used by the
 * PR diff view). The base snapshot's assignment for a slug plays the role of
 * the 3-way merge-base in the (target, source) pair.
 *
 * The returned rows are one per slug that appears in the target snapshot or
 * any source leg snapshot. Slugs that exist only in a base snapshot are not
 * included. The caller (classifier) further filters rows that cannot be
 * classified.
 */
export async function buildMergeClassifierInputs({
    db,
    targetSnapshotId,
    sources,
}: BuildMergeClassifierInputsParams): Promise<ClassifierInputRow[]> {
    const logger = rootLogger.child({
        name: "buildMergeClassifierInputs",
        targetSnapshotId,
        sourceCount: sources.length,
    });
    logger.info("Loading assignments for merge classification");

    const baseSnapshotIds = sources.map((s) => s.baseSnapshotId).filter((id): id is string => id != null);
    const allSnapshotIds = Array.from(
        new Set<string>([targetSnapshotId, ...sources.map((s) => s.snapshotId), ...baseSnapshotIds]),
    );

    const assignments = await db.testCaseAssignment.findMany({
        where: { snapshotId: { in: allSnapshotIds } },
        select: {
            id: true,
            snapshotId: true,
            planId: true,
            testCase: { select: { id: true, slug: true, name: true } },
        },
    });

    logger.info("Loaded assignments", { count: assignments.length });

    const bySnapshotAndSlug = new Map<string, Map<string, (typeof assignments)[number]>>();
    const slugToName = new Map<string, string>();
    const sourceSnapshotIds = new Set(sources.map((s) => s.snapshotId));
    const allSlugs = new Set<string>();

    for (const a of assignments) {
        slugToName.set(a.testCase.slug, a.testCase.name);

        let perSnapshot = bySnapshotAndSlug.get(a.snapshotId);
        if (perSnapshot == null) {
            perSnapshot = new Map();
            bySnapshotAndSlug.set(a.snapshotId, perSnapshot);
        }
        perSnapshot.set(a.testCase.slug, a);

        // Slugs that exist only in a base snapshot (not in target or any source) are not classifiable.
        if (a.snapshotId === targetSnapshotId || sourceSnapshotIds.has(a.snapshotId)) {
            allSlugs.add(a.testCase.slug);
        }
    }

    const rows: ClassifierInputRow[] = [];
    for (const slug of allSlugs) {
        const targetAssignment = bySnapshotAndSlug.get(targetSnapshotId)?.get(slug);
        const target: ClassifierInputAssignment | null =
            targetAssignment != null ? { assignmentId: targetAssignment.id, planId: targetAssignment.planId } : null;

        const sourceLegs = sources.map((source) => {
            const sourceAssignment = bySnapshotAndSlug.get(source.snapshotId)?.get(slug);
            const leg: ClassifierInputAssignment | null =
                sourceAssignment != null
                    ? { assignmentId: sourceAssignment.id, planId: sourceAssignment.planId }
                    : null;
            const baseAssignment =
                source.baseSnapshotId != null ? bySnapshotAndSlug.get(source.baseSnapshotId)?.get(slug) : undefined;
            const base: ClassifierInputAssignment | null =
                baseAssignment != null ? { assignmentId: baseAssignment.id, planId: baseAssignment.planId } : null;
            return { sourceName: source.branchName, prNumber: source.prNumber, leg, base };
        });

        rows.push({
            slug,
            testName: slugToName.get(slug) ?? slug,
            target,
            sources: sourceLegs,
        });
    }

    logger.info("Built classifier input rows", { rowCount: rows.length });
    return rows;
}
