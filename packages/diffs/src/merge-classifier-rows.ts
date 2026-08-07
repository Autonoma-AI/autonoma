import { logger as rootLogger } from "@autonoma/logger";
import type { SuiteAssignment } from "@autonoma/test-suite";
import type { AssignmentRef, ClassifyTestInput } from "./merge-classification";

export interface MergeClassifierSource {
    snapshotId: string;
    branchName: string;
    prNumber: number;
    /** The source branch's fork point. When absent the source contributes no merge-base leg. */
    baseSnapshotId: string | null;
}

/**
 * A classifier input row plus the identity the caller acts on once a classification comes back: the classifier
 * itself reads only {@link ClassifyTestInput}, but an import writes against the test case and a conflict is
 * rendered under the test's name.
 */
export interface MergeClassifierRow extends ClassifyTestInput {
    testCaseId: string;
    testName: string;
}

export interface BuildMergeClassifierRowsParams {
    /** Every assignment of the target, source and base snapshots - see `TestSuiteStore.readAssignments`. */
    assignments: SuiteAssignment[];
    targetSnapshotId: string;
    sources: MergeClassifierSource[];
}

/**
 * A row is emitted for every slug the target snapshot or any source leg assigns; a slug that exists only in a
 * base snapshot is not classifiable and is dropped. Within a row, the base snapshot's assignment plays the role
 * of the 3-way merge base for its `(target, source)` pair.
 */
export function buildMergeClassifierRows({
    assignments,
    targetSnapshotId,
    sources,
}: BuildMergeClassifierRowsParams): MergeClassifierRow[] {
    const logger = rootLogger.child({ name: "buildMergeClassifierRows" });

    const bySnapshotAndSlug = new Map<string, Map<string, SuiteAssignment>>();
    const sourceSnapshotIds = new Set(sources.map((source) => source.snapshotId));
    const classifiable = new Map<string, SuiteAssignment>();

    for (const assignment of assignments) {
        let perSnapshot = bySnapshotAndSlug.get(assignment.snapshotId);
        if (perSnapshot == null) {
            perSnapshot = new Map();
            bySnapshotAndSlug.set(assignment.snapshotId, perSnapshot);
        }
        perSnapshot.set(assignment.slug, assignment);

        const isClassifiableLeg =
            assignment.snapshotId === targetSnapshotId || sourceSnapshotIds.has(assignment.snapshotId);
        if (isClassifiableLeg) classifiable.set(assignment.slug, assignment);
    }

    const refAt = (snapshotId: string | null | undefined, slug: string): AssignmentRef | null => {
        if (snapshotId == null) return null;
        const assignment = bySnapshotAndSlug.get(snapshotId)?.get(slug);
        if (assignment == null) return null;
        return { assignmentId: assignment.assignmentId, planId: assignment.planId };
    };

    const rows = Array.from(classifiable, ([slug, assignment]) => ({
        slug,
        testCaseId: assignment.testCaseId,
        testName: assignment.testName,
        target: refAt(targetSnapshotId, slug),
        sources: sources.map((source) => ({
            sourceName: source.branchName,
            prNumber: source.prNumber,
            leg: refAt(source.snapshotId, slug),
            base: refAt(source.baseSnapshotId, slug),
        })),
    }));

    logger.info("Built merge classifier rows", {
        snapshot: { snapshotId: targetSnapshotId },
        extra: { sourceCount: sources.length, rowCount: rows.length },
    });
    return rows;
}
