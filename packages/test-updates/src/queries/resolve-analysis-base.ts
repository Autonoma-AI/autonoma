import type { PrismaClient } from "@autonoma/db";

export interface ResolveAnalysisBaseParams {
    db: PrismaClient;
    branchId: string;
    headSha: string;
    /** Only used for a branch with no active snapshot yet - the PR base the trigger read from GitHub. */
    fallbackBaseSha?: string;
}

export interface AnalysisBase {
    /** Absent when the branch has never been analyzed and the caller knew no base either. */
    baseSha?: string;
    /** The head is already the base, so there is nothing new to diff. */
    alreadyAnalyzed: boolean;
}

/**
 * Both the API trigger and the run's own `openAnalysisRun` ask this, and they have to agree: the trigger answers
 * a merge-gate request synchronously ("nothing new to analyze") while the run decides whether to open a snapshot
 * at all, and a disagreement would either drop a run or open an empty one.
 */
export async function resolveAnalysisBase({
    db,
    branchId,
    headSha,
    fallbackBaseSha,
}: ResolveAnalysisBaseParams): Promise<AnalysisBase> {
    const branch = await db.branch.findUnique({
        where: { id: branchId },
        select: { activeSnapshot: { select: { headSha: true } } },
    });

    const baseSha = branch?.activeSnapshot?.headSha ?? fallbackBaseSha;
    return { baseSha, alreadyAnalyzed: baseSha != null && baseSha === headSha };
}
