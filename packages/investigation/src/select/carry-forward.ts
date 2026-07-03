import type { PrismaClient } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";

/**
 * Selects the existing tests to CARRY FORWARD into an investigation twin's run set: the tests that did not
 * pass on the branch's previous twin. This is the "regression running" mechanism - a test that failed on
 * snapshot N is re-run on snapshot N+1 (a failure is assumed unfixed until a run proves otherwise), and it
 * retires automatically the first snapshot it passes, because a passing test is simply absent from this set.
 *
 * The carry-forward set is derived from the previous twin's actual RUN RESULTS (its shadow generations), never
 * from "every test in the catalog now" - so it can never re-introduce a test that post-dates the snapshot's
 * base (the base-relative data-leak fix). It returns slugs only; the caller re-materializes each against the
 * CURRENT snapshot's pinned baseline plan, so a carried test that no longer exists in this baseline is skipped.
 */
export class CarryForwardSelector {
    private readonly logger: Logger;

    constructor(private readonly db: PrismaClient) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    /**
     * The distinct slugs of tests to RE-RUN this snapshot for regression: tests that did NOT pass on the
     * branch's previous (non-superseded) twin, minus `alreadySelected` (the tests the diff already picked, so
     * nothing runs twice). The result is fully deduped - the caller can materialize each slug directly without
     * its own bookkeeping. Empty when there is no prior twin (the branch's first investigation), every test
     * passed there, or every non-passing test is already selected.
     */
    async selectCarriedSlugs(currentSnapshotId: string, alreadySelected: Iterable<string> = []): Promise<string[]> {
        const ids = { snapshot: { snapshotId: currentSnapshotId } };
        this.logger.info("Selecting carry-forward tests", ids);

        const current = await this.db.branchSnapshot.findUnique({
            where: { id: currentSnapshotId },
            select: { branchId: true, createdAt: true, investigationParent: { select: { id: true } } },
        });
        if (current == null) {
            this.logger.warn("Current snapshot not found; nothing to carry forward", ids);
            return [];
        }
        if (current.investigationParent == null) {
            // Defense-in-depth: carry-forward only makes sense for an investigation twin's run set. The sole
            // caller runs on the twin, but never carry forward if this is somehow a non-twin (diffs) snapshot.
            this.logger.warn("Snapshot is not an investigation twin; nothing to carry forward", ids);
            return [];
        }

        const priorTwin = await this.findPriorTwin(current.branchId, currentSnapshotId, current.createdAt);
        if (priorTwin == null) {
            this.logger.info("No prior twin on the branch; nothing to carry forward", ids);
            return [];
        }

        const nonPassing = await this.nonPassingSlugs(priorTwin.id);
        const selected = new Set(alreadySelected);
        const carried = nonPassing.filter((slug) => !selected.has(slug));
        this.logger.info("Carry-forward tests selected", {
            ...ids,
            extra: { priorTwinId: priorTwin.id, nonPassing: nonPassing.length, carried: carried.length },
        });
        return carried;
    }

    /**
     * The most recent investigation twin on the branch created before the current one, excluding superseded
     * (`cancelled`) twins: their run was cut short by a newer push, so their results are not a reliable "still
     * failing" signal - we fall back to the last twin that actually ran, whose failures are still unfixed. A
     * twin is identified by `investigationParent` (a diffs snapshot pairs to it via `investigationSnapshotId`),
     * the canonical "this snapshot is a twin" signal that also hides it from user-facing snapshot history.
     */
    private async findPriorTwin(
        branchId: string,
        currentSnapshotId: string,
        before: Date,
    ): Promise<{ id: string } | undefined> {
        const twin = await this.db.branchSnapshot.findFirst({
            where: {
                branchId,
                id: { not: currentSnapshotId },
                createdAt: { lt: before },
                status: { not: "cancelled" },
                investigationParent: { isNot: null },
            },
            orderBy: { createdAt: "desc" },
            select: { id: true },
        });
        return twin ?? undefined;
    }

    /**
     * The distinct catalog slugs of tests that never succeeded on a twin: test cases with at least one shadow
     * generation on the twin but NO successful one. The group-by + "never passed" filter is pushed into the DB
     * (one bounded query, one row per test case - slug is unique per app). Keying on "did it ever pass on the
     * twin" (not "did its last run fail") lets a branch-scoped recipe/plan fix that made the test pass count as
     * passing, and it is self-correcting: each snapshot re-derives the set from that snapshot's own runs.
     */
    private async nonPassingSlugs(twinSnapshotId: string): Promise<string[]> {
        const onTwin = { snapshotId: twinSnapshotId, shadow: true };
        const cases = await this.db.testCase.findMany({
            where: {
                plans: { some: { generations: { some: onTwin } } },
                NOT: { plans: { some: { generations: { some: { ...onTwin, status: "success" } } } } },
            },
            select: { slug: true },
        });
        return cases.map((testCase) => testCase.slug);
    }
}
