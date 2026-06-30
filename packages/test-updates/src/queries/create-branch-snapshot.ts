import { type Prisma, TriggerSource } from "@autonoma/db";
import type { Logger } from "@autonoma/logger";

export interface SourceBranchInfo {
    activeSnapshotId: string | null;
    application: {
        mainBranchId: string | null;
        mainBranch: { activeSnapshotId: string | null } | null;
    };
}

/**
 * Resolves the snapshot a new snapshot should fork from: the branch's own active
 * snapshot, else the application's main branch active snapshot (so a brand new PR
 * branch inherits the live suite from main), else none. `sourceSnapshotId` is
 * `undefined` only when there is no baseline suite anywhere to copy from.
 */
export function resolveSnapshotSource(
    branchId: string,
    branch: SourceBranchInfo,
): { sourceSnapshotId?: string; sourceKind: "branch-active" | "main-branch" | "none" } {
    const isMainBranch = branch.application.mainBranchId === branchId;
    const mainBranchActiveSnapshotId = isMainBranch
        ? undefined
        : (branch.application.mainBranch?.activeSnapshotId ?? undefined);
    const sourceSnapshotId = branch.activeSnapshotId ?? mainBranchActiveSnapshotId;
    const sourceKind =
        branch.activeSnapshotId != null ? "branch-active" : sourceSnapshotId != null ? "main-branch" : "none";
    return { sourceSnapshotId, sourceKind };
}

interface CreateBranchSnapshotParams {
    tx: Prisma.TransactionClient;
    branchId: string;
    branch: SourceBranchInfo;
    source?: TriggerSource;
    headSha?: string;
    baseSha?: string;
    logger: Logger;
}

/**
 * Creates a new branch snapshot and copies test case assignments from the
 * appropriate source snapshot:
 * - the branch's own active snapshot if it has one, or
 * - the application's main branch active snapshot (so a brand new PR branch inherits
 *   the live suite from main).
 *
 * `prevSnapshotId` on the new snapshot is set to whichever source was used, so the
 * diff machinery in `getChanges()` can report adds/removes/updates relative to it.
 *
 * The caller is responsible for (a) running inside a Prisma transaction with the
 * branch row already locked, and (b) wiring the returned snapshot as the branch's
 * pending snapshot.
 */
export async function createBranchSnapshot({
    tx,
    branchId,
    branch,
    source,
    headSha,
    baseSha,
    logger,
}: CreateBranchSnapshotParams): Promise<{ snapshotId: string }> {
    const { sourceSnapshotId, sourceKind } = resolveSnapshotSource(branchId, branch);

    logger.info("Creating new branch snapshot", { branchId, prevSnapshotId: sourceSnapshotId, sourceKind });
    const created = await tx.branchSnapshot.create({
        data: {
            branchId,
            source: source ?? TriggerSource.MANUAL,
            headSha,
            baseSha,
            prevSnapshotId: sourceSnapshotId,
        },
        select: { id: true },
    });

    if (sourceSnapshotId != null) {
        await copyTestCaseAssignments({ tx, sourceSnapshotId, sourceKind, targetSnapshotId: created.id, logger });
        await copyScenarioRecipeVersions({ tx, sourceSnapshotId, sourceKind, targetSnapshotId: created.id, logger });
    }

    return { snapshotId: created.id };
}

interface CopyParams {
    tx: Prisma.TransactionClient;
    sourceSnapshotId: string;
    sourceKind: string;
    targetSnapshotId: string;
    logger: Logger;
}

async function copyTestCaseAssignments({ tx, sourceSnapshotId, sourceKind, targetSnapshotId, logger }: CopyParams) {
    logger.info("Retrieving test case assignments from source snapshot", { sourceSnapshotId, sourceKind });
    const assignments = await tx.testCaseAssignment.findMany({
        where: { snapshotId: sourceSnapshotId },
        select: {
            testCaseId: true,
            planId: true,
            stepsId: true,
            quarantineIssueId: true,
        },
    });

    if (assignments.length === 0) return;

    logger.info("Copying test case assignments from source snapshot", {
        sourceSnapshotId,
        sourceKind,
        assignmentCount: assignments.length,
        quarantinedAssignmentCount: assignments.filter((a) => a.quarantineIssueId != null).length,
    });
    await tx.testCaseAssignment.createMany({
        data: assignments.map((a) => {
            const isQuarantined = a.quarantineIssueId != null;
            return {
                snapshotId: targetSnapshotId,
                testCaseId: a.testCaseId,
                planId: a.planId ?? undefined,
                stepsId: isQuarantined ? undefined : (a.stepsId ?? undefined),
                quarantineIssueId: a.quarantineIssueId ?? undefined,
            };
        }),
    });
}

async function copyScenarioRecipeVersions({ tx, sourceSnapshotId, sourceKind, targetSnapshotId, logger }: CopyParams) {
    const schemaSnapshots = await tx.scenarioSchemaSnapshot.findMany({
        where: { snapshotId: sourceSnapshotId },
        select: { id: true, applicationId: true, structureJson: true, fingerprint: true },
    });

    if (schemaSnapshots.length === 0) return;

    const schemaIdMap = new Map<string, string>();
    for (const ss of schemaSnapshots) {
        const created = await tx.scenarioSchemaSnapshot.create({
            data: {
                applicationId: ss.applicationId,
                snapshotId: targetSnapshotId,
                structureJson: ss.structureJson ?? undefined,
                fingerprint: ss.fingerprint,
            },
            select: { id: true },
        });
        schemaIdMap.set(ss.id, created.id);
    }

    const recipeVersions = await tx.scenarioRecipeVersion.findMany({
        where: { snapshotId: sourceSnapshotId },
        select: {
            scenarioId: true,
            schemaSnapshotId: true,
            applicationId: true,
            organizationId: true,
            scenarioNameSnapshot: true,
            description: true,
            fingerprint: true,
            validationStatus: true,
            validationMethod: true,
            validationPhase: true,
            validationUpMs: true,
            validationDownMs: true,
            fixtureJson: true,
        },
    });

    if (recipeVersions.length === 0) return;

    logger.info("Copying scenario recipe versions from source snapshot", {
        sourceSnapshotId,
        sourceKind,
        schemaSnapshotCount: schemaSnapshots.length,
        recipeVersionCount: recipeVersions.length,
    });

    await tx.scenarioRecipeVersion.createMany({
        data: recipeVersions.map((rv) => ({
            scenarioId: rv.scenarioId,
            snapshotId: targetSnapshotId,
            schemaSnapshotId: getOrThrow(schemaIdMap, rv.schemaSnapshotId),
            applicationId: rv.applicationId,
            organizationId: rv.organizationId,
            scenarioNameSnapshot: rv.scenarioNameSnapshot,
            description: rv.description ?? undefined,
            fingerprint: rv.fingerprint,
            validationStatus: rv.validationStatus,
            validationMethod: rv.validationMethod,
            validationPhase: rv.validationPhase,
            validationUpMs: rv.validationUpMs ?? undefined,
            validationDownMs: rv.validationDownMs ?? undefined,
            fixtureJson: rv.fixtureJson ?? undefined,
        })),
    });
}

function getOrThrow(map: Map<string, string>, key: string): string {
    const value = map.get(key);
    if (value == null) {
        throw new Error(`Missing schema snapshot mapping for ${key}`);
    }
    return value;
}
