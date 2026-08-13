import type { PrismaClient } from "@autonoma/db";
import type { RepoCloneSpec, UnavailableRepo } from "@autonoma/diffs";
import { logger as rootLogger } from "@autonoma/logger";
import { parseSnapshotDependencyShaMap } from "@autonoma/types";

/**
 * The dependency repos to check out beside a snapshot's primary repo: the ones
 * that can be cloned ({@link RepoCloneSpec}) and the ones pinned but not
 * ({@link UnavailableRepo}).
 */
export interface ResolvedDependencyCheckouts {
    dependencies: RepoCloneSpec[];
    unavailable: UnavailableRepo[];
}

/** A pinned dependency cannot be reached past this many ancestors when searching for a diff base. */
const MAX_BASE_LOOKBACK = 50;

const EMPTY: ResolvedDependencyCheckouts = { dependencies: [], unavailable: [] };

/** A pin key is checkout-able only if it is a real `owner/repo` full name; legacy alias keys are inert. */
function isResolvableRepo(name: string): boolean {
    return name.includes("/");
}

/**
 * Resolves the multi-repo checkout for a snapshot's grounding agents from its
 * pinned dependency map (`pinnedDependencyShas`, keyed by lowercased
 * `owner/repo`). Each dependency is cloned at its pinned sha on *this* snapshot,
 * with base = the same dependency's pinned sha on the most recent *previous*
 * snapshot that pinned it (walking `prevSnapshotId`) - so it exposes
 * `git diff base..head`, the incremental change since the last review. No
 * previous pin -> no base (read-only).
 *
 * Legacy alias-keyed pins (a key without a `/`, from the retired multirepo
 * config) are not resolvable to a repo and are skipped. Degrades to no
 * dependencies on any error - a fidelity gap must not block the run.
 */
export async function resolveDependencyCheckouts(
    db: PrismaClient,
    snapshotId: string,
): Promise<ResolvedDependencyCheckouts> {
    const logger = rootLogger.child({ name: "resolveDependencyCheckouts", extra: { snapshotId } });
    try {
        const snapshot = await db.branchSnapshot.findUniqueOrThrow({
            where: { id: snapshotId },
            select: { prevSnapshotId: true, pinnedDependencyShas: true },
        });

        const currentShas = parseSnapshotDependencyShaMap(snapshot.pinnedDependencyShas);
        const resolvable = Object.entries(currentShas).filter(([name]) => isResolvableRepo(name));
        if (resolvable.length === 0) {
            logger.info("Snapshot pinned no resolvable dependencies, single-repo checkout");
            return EMPTY;
        }

        const baseShas = await resolveBaseShas(
            db,
            snapshot.prevSnapshotId,
            resolvable.map(([name]) => name),
            logger,
        );

        const dependencies: RepoCloneSpec[] = resolvable.map(([name, commitSha]) => ({
            name,
            commitSha,
            baseSha: baseShas[name],
        }));
        logger.info("Resolved dependency checkouts", { extra: { dependencies: dependencies.length } });
        return { dependencies, unavailable: [] };
    } catch (error) {
        logger.warn("Failed to resolve dependency checkouts, degrading to single-repo", { extra: { error } });
        return EMPTY;
    }
}

/**
 * Walks `prevSnapshotId` back from the given starting point, assigning each
 * dependency the sha from the nearest ancestor snapshot that pinned it. Stops
 * once every dependency has a base, the chain ends, or the lookback cap is hit.
 */
async function resolveBaseShas(
    db: PrismaClient,
    startPrevSnapshotId: string | null,
    names: string[],
    logger: ReturnType<typeof rootLogger.child>,
): Promise<Record<string, string>> {
    const baseShas: Record<string, string> = {};
    const remaining = new Set(names);

    let cursor = startPrevSnapshotId;
    for (let hops = 0; cursor != null && remaining.size > 0 && hops < MAX_BASE_LOOKBACK; hops += 1) {
        const ancestor = await db.branchSnapshot.findUnique({
            where: { id: cursor },
            select: { prevSnapshotId: true, pinnedDependencyShas: true },
        });
        if (ancestor == null) break;

        const ancestorShas = parseSnapshotDependencyShaMap(ancestor.pinnedDependencyShas);
        for (const name of [...remaining]) {
            const sha = ancestorShas[name];
            if (sha != null) {
                baseShas[name] = sha;
                remaining.delete(name);
            }
        }
        cursor = ancestor.prevSnapshotId;
    }

    logger.info("Resolved dependency diff bases", {
        extra: { withBase: Object.keys(baseShas).length, readOnly: remaining.size },
    });
    return baseShas;
}
