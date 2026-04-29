import type { PrismaClient } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";

export interface MergePlanImport {
    /** Assignment id in the pinned source snapshot from which we read the winning plan/steps. */
    sourceAssignmentId: string;
}

export interface ApplyMergePlanImportsParams {
    db: PrismaClient;
    targetSnapshotId: string;
    imports: MergePlanImport[];
}

export interface AppliedMergePlanImport {
    slug: string;
    testCaseId: string;
    targetAssignmentId: string;
    planId: string | null;
    stepsId: string | null;
    /** Whether a new row was created (target had no assignment for this test) or the existing one was updated in place. */
    operation: "created" | "updated";
}

/**
 * Applies the winning plan/steps from source snapshots into the target snapshot's
 * TestCaseAssignments. Used for the `unilateral_update` and `new_test`
 * classifications before dispatching replay runs with `merge_plan_imported`.
 *
 * - If the target already has an assignment for the slug, it is updated in
 *   place so the assignmentId stays stable for downstream consumers.
 * - Otherwise a new row is created.
 *
 * All writes happen inside a single Prisma transaction. The caller is
 * responsible for ensuring the target snapshot is still in the `processing`
 * state (i.e. its draft has not been activated yet).
 */
export async function applyMergePlanImports({
    db,
    targetSnapshotId,
    imports,
}: ApplyMergePlanImportsParams): Promise<AppliedMergePlanImport[]> {
    const logger = rootLogger.child({
        name: "applyMergePlanImports",
        targetSnapshotId,
        importCount: imports.length,
    });

    if (imports.length === 0) {
        logger.info("No imports to apply");
        return [];
    }

    logger.info("Applying merge plan imports to target snapshot");

    const sourceAssignments = await db.testCaseAssignment.findMany({
        where: { id: { in: imports.map((i) => i.sourceAssignmentId) } },
        select: {
            id: true,
            testCaseId: true,
            planId: true,
            stepsId: true,
            testCase: { select: { slug: true } },
        },
    });

    const sourceById = new Map(sourceAssignments.map((s) => [s.id, s]));

    return await db.$transaction(async (tx) => {
        const results: AppliedMergePlanImport[] = [];

        const targetAssignments = await tx.testCaseAssignment.findMany({
            where: {
                snapshotId: targetSnapshotId,
                testCaseId: { in: sourceAssignments.map((s) => s.testCaseId) },
            },
            select: { id: true, testCaseId: true },
        });
        const targetByTestCaseId = new Map(targetAssignments.map((t) => [t.testCaseId, t]));

        for (const imp of imports) {
            const source = sourceById.get(imp.sourceAssignmentId);
            if (source == null) {
                logger.warn("Source assignment not found; skipping import", {
                    sourceAssignmentId: imp.sourceAssignmentId,
                });
                continue;
            }

            const existingTarget = targetByTestCaseId.get(source.testCaseId);

            if (existingTarget != null) {
                const updated = await tx.testCaseAssignment.update({
                    where: { id: existingTarget.id },
                    data: {
                        planId: source.planId,
                        stepsId: source.stepsId,
                    },
                    select: { id: true, planId: true, stepsId: true },
                });
                results.push({
                    slug: source.testCase.slug,
                    testCaseId: source.testCaseId,
                    targetAssignmentId: updated.id,
                    planId: updated.planId,
                    stepsId: updated.stepsId,
                    operation: "updated",
                });
                continue;
            }

            const created = await tx.testCaseAssignment.create({
                data: {
                    snapshotId: targetSnapshotId,
                    testCaseId: source.testCaseId,
                    planId: source.planId ?? undefined,
                    stepsId: source.stepsId ?? undefined,
                },
                select: { id: true, planId: true, stepsId: true },
            });
            results.push({
                slug: source.testCase.slug,
                testCaseId: source.testCaseId,
                targetAssignmentId: created.id,
                planId: created.planId,
                stepsId: created.stepsId,
                operation: "created",
            });
        }

        logger.info("Applied merge plan imports", {
            applied: results.length,
            created: results.filter((r) => r.operation === "created").length,
            updated: results.filter((r) => r.operation === "updated").length,
        });

        return results;
    });
}
