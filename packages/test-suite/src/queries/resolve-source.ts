import type { PrismaClient } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";

const logger = rootLogger.child({ name: "resolveSnapshotSource" });

/**
 * The snapshot a new snapshot reads and forks from. When the source belongs to the branch itself,
 * `baseSha` is derived from its head, so the pair cannot diverge; the free-floating base sha exists
 * only where the source cannot speak for the branch's own history.
 */
export type SnapshotSource =
    | {
          snapshotId: string;
          /**
           * The base to diff against when the source snapshot cannot provide one: it belongs to
           * another branch (a new PR branch inherits main's suite but diffs against its own PR
           * base - clients do not analyze every merge to main, so the inherited snapshot's head
           * can lag the real fork point), or it records no head sha (onboarding-created). Without
           * it, such a source cannot yield a base and opening throws.
           */
          fallbackBaseSha?: string;
      }
    | { noPriorSnapshot: { baseSha: string } };

export interface ResolveSourceInput {
    branchId: string;
    /** The head the new snapshot would be opened for - what `alreadyAnalyzed` is judged against. */
    headSha: string;
    /** The base the trigger knew independently (the PR base). */
    fallbackBaseSha?: string;
}

export interface ResolvedSnapshotSource {
    /** Absent when there is no suite to fork from anywhere and the caller knew no base either. */
    source?: SnapshotSource;
    /** The base sha a snapshot opened from `source` would derive. Absent when none is derivable. */
    baseSha?: string;
    /** The head is already the base, so there is nothing new to analyze. */
    alreadyAnalyzed: boolean;
}

/**
 * The one rule turning a source into a diff base, shared by `resolveSnapshotSource` and
 * `TestSuiteStore.openSnapshot` so the answer the trigger saw and the base the snapshot records
 * cannot disagree. A branch's own snapshot speaks for its history (its head is the base); a foreign
 * one contributes only the suite, so the base is the caller's.
 */
export function deriveBaseSha(params: {
    sourceBelongsToBranch: boolean;
    sourceHeadSha?: string;
    fallbackBaseSha?: string;
}): string | undefined {
    if (!params.sourceBelongsToBranch) return params.fallbackBaseSha;
    return params.sourceHeadSha ?? params.fallbackBaseSha;
}

/**
 * Resolve what a new snapshot on the branch would fork from: the branch's own active snapshot, else
 * the application's main branch active snapshot (a brand new PR branch inherits the live suite), else
 * nothing. The one deriving site for `baseSha` and `alreadyAnalyzed` - the API trigger answers a
 * merge-gate request from this while the run decides whether to open a snapshot at all, and a
 * disagreement would either drop a run or open an empty one.
 */
export async function resolveSnapshotSource(
    db: PrismaClient,
    { branchId, headSha, fallbackBaseSha }: ResolveSourceInput,
): Promise<ResolvedSnapshotSource> {
    const branch = await db.branch.findUnique({
        where: { id: branchId },
        select: {
            activeSnapshot: { select: { id: true, headSha: true } },
            application: {
                select: {
                    mainBranchId: true,
                    mainBranch: { select: { activeSnapshot: { select: { id: true, headSha: true } } } },
                },
            },
        },
    });
    if (branch == null) {
        logger.warn("Cannot resolve a snapshot source for an unknown branch", { branch: { branchId } });
        return { alreadyAnalyzed: false };
    }

    const ownSnapshot = branch.activeSnapshot ?? undefined;
    const isMainBranch = branch.application.mainBranchId === branchId;
    const inheritedSnapshot = isMainBranch ? undefined : (branch.application.mainBranch?.activeSnapshot ?? undefined);
    const sourceSnapshot = ownSnapshot ?? inheritedSnapshot;

    const resolved = buildResolvedSource({
        sourceSnapshot,
        sourceBelongsToBranch: ownSnapshot != null,
        fallbackBaseSha,
        headSha,
    });
    logger.info("Resolved snapshot source", {
        branch: { branchId },
        extra: {
            sourceSnapshotId: sourceSnapshot?.id,
            baseSha: resolved.baseSha,
            alreadyAnalyzed: resolved.alreadyAnalyzed,
        },
    });
    return resolved;
}

function buildResolvedSource(params: {
    sourceSnapshot?: { id: string; headSha: string | null };
    sourceBelongsToBranch: boolean;
    fallbackBaseSha?: string;
    headSha: string;
}): ResolvedSnapshotSource {
    const { sourceSnapshot, sourceBelongsToBranch, fallbackBaseSha, headSha } = params;
    if (sourceSnapshot != null) {
        const baseSha = deriveBaseSha({
            sourceBelongsToBranch,
            sourceHeadSha: sourceSnapshot.headSha ?? undefined,
            fallbackBaseSha,
        });
        return {
            source: { snapshotId: sourceSnapshot.id, fallbackBaseSha },
            baseSha,
            alreadyAnalyzed: baseSha != null && baseSha === headSha,
        };
    }
    if (fallbackBaseSha != null) {
        return {
            source: { noPriorSnapshot: { baseSha: fallbackBaseSha } },
            baseSha: fallbackBaseSha,
            alreadyAnalyzed: fallbackBaseSha === headSha,
        };
    }
    return { alreadyAnalyzed: false };
}
