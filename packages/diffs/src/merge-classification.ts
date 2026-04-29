import { logger as rootLogger } from "@autonoma/logger";

/**
 * Reference to a specific test case assignment: its row id plus the test plan
 * pointer it carries. A null `planId` represents a test without an active plan
 * at that leg - i.e. quarantined. Quarantine vs edit is intentionally not a
 * separate case in Phase 1; the classifier treats null like any other plan
 * pointer value.
 */
export interface AssignmentRef {
    assignmentId: string;
    planId: string | null;
}

/**
 * A source leg in the classification, corresponding to one pinned source
 * snapshot at the PR's `headSha` (works uniformly across merge/squash/rebase
 * strategies, unlike the merge commit's parent SHA).
 *
 * - `leg` is the test's assignment in the pinned source snapshot, or null if
 *   the source did not have this test (e.g. quarantined or absent).
 * - `base` is the test's assignment in the source branch's merge-base
 *   snapshot (resolved from `branch.baseSnapshotId`, with the prev-snapshot
 *   fallback used by the PR diff view). Plays the role of the 3-way
 *   merge-base for the (target, source) pair.
 */
export interface ClassifierSource {
    sourceName: string;
    prNumber: number;
    leg: AssignmentRef | null;
    base: AssignmentRef | null;
}

/**
 * Per-test input to the classifier. `target` is the current state on the
 * primary-parent branch (main). Phase 1 only handles `feat/x -> main`.
 */
export interface ClassifyTestInput {
    slug: string;
    target: AssignmentRef | null;
    sources: ClassifierSource[];
}

export type ConflictVersion =
    | { role: "target-current"; ref: AssignmentRef }
    | { role: "target-base"; ref: AssignmentRef }
    | { role: "source"; sourceName: string; prNumber: number; ref: AssignmentRef };

/**
 * Outcome of classifying a single test across a merge's legs.
 *
 * - `unilateral_update`: exactly one side (target or a single source) diverged
 *   from the shared merge base. The plan from that side is the winner and can
 *   be adopted without re-planning.
 * - `new_test`: the test exists only on a source leg with no counterpart on
 *   the target. Adopt the source plan as a brand-new assignment on the target.
 * - `conflict`: multiple sides modified the test in incompatible ways. Needs
 *   re-planning; the agent will receive every leg to produce a reasoning.
 * - `no_change`: nothing to do - either nobody modified the test or every side
 *   converged on the same plan.
 */
export type Classification =
    | {
          slug: string;
          kind: "unilateral_update";
          winning: AssignmentRef;
          winningFrom: "target" | { sourceName: string; prNumber: number };
      }
    | {
          slug: string;
          kind: "new_test";
          newAssignment: AssignmentRef;
          winningFrom: { sourceName: string; prNumber: number };
      }
    | {
          slug: string;
          kind: "conflict";
          versions: ConflictVersion[];
          involvedPrNumbers: number[];
      }
    | { slug: string; kind: "no_change" };

export function classifyTestsForMerge(inputs: ClassifyTestInput[]): Classification[] {
    const logger = rootLogger.child({ name: "classifyTestsForMerge" });
    logger.info("Classifying tests for merge", { inputCount: inputs.length });

    const results: Classification[] = [];
    for (const input of inputs) {
        const classification = classifyOne(input);
        if (classification != null) results.push(classification);
    }

    logger.info("Classification complete", {
        total: results.length,
        byKind: tallyByKind(results),
    });
    return results;
}

function classifyOne(input: ClassifyTestInput): Classification | null {
    const { slug, target, sources } = input;

    const presentSources = sources.filter((s) => s.leg != null || s.base != null);
    if (presentSources.length === 0) return null;

    const modifyingSources = presentSources.filter((s) => !planIdsEqual(legPlan(s), basePlan(s)));

    if (target == null) {
        return classifyWithoutTarget(slug, presentSources, modifyingSources);
    }

    if (modifyingSources.length === 0) {
        const targetDivergesFromAnyBase = presentSources.some(
            (s) => s.base != null && !planIdsEqual(target.planId, s.base.planId),
        );
        if (targetDivergesFromAnyBase) {
            return { slug, kind: "unilateral_update", winning: target, winningFrom: "target" };
        }
        return { slug, kind: "no_change" };
    }

    if (modifyingSources.length === 1) {
        return classifyOneModifyingSource(slug, target, modifyingSources[0]!);
    }

    return classifyManyModifyingSources(slug, target, modifyingSources);
}

function classifyWithoutTarget(
    slug: string,
    presentSources: ClassifierSource[],
    modifyingSources: ClassifierSource[],
): Classification | null {
    if (modifyingSources.length === 0) return { slug, kind: "no_change" };

    const allHaveNullBase = modifyingSources.every((s) => s.base == null);
    if (allHaveNullBase) {
        const distinctPlans = new Set(modifyingSources.map((s) => legPlan(s)));
        if (distinctPlans.size === 1) {
            const only = modifyingSources[0]!;
            if (only.leg == null) return { slug, kind: "no_change" };
            return {
                slug,
                kind: "new_test",
                newAssignment: only.leg,
                winningFrom: { sourceName: only.sourceName, prNumber: only.prNumber },
            };
        }
        return buildConflict(slug, undefined, modifyingSources);
    }

    return buildConflict(slug, undefined, modifyingSources, presentSources);
}

function classifyOneModifyingSource(slug: string, target: AssignmentRef, only: ClassifierSource): Classification {
    if (planIdsEqual(target.planId, legPlan(only))) {
        return { slug, kind: "no_change" };
    }
    if (planIdsEqual(target.planId, basePlan(only))) {
        if (only.leg == null) {
            return buildConflict(slug, target, [only]);
        }
        return {
            slug,
            kind: "unilateral_update",
            winning: only.leg,
            winningFrom: { sourceName: only.sourceName, prNumber: only.prNumber },
        };
    }
    return buildConflict(slug, target, [only]);
}

function classifyManyModifyingSources(
    slug: string,
    target: AssignmentRef,
    modifyingSources: ClassifierSource[],
): Classification {
    const distinctLegPlans = new Set(modifyingSources.map((s) => legPlan(s)));
    const allLegsAgree = distinctLegPlans.size === 1;
    const agreedLegPlan = allLegsAgree ? (modifyingSources[0]!.leg?.planId ?? null) : undefined;

    if (allLegsAgree && planIdsEqual(target.planId, agreedLegPlan ?? null)) {
        return { slug, kind: "no_change" };
    }

    if (allLegsAgree) {
        const allSameBase = new Set(modifyingSources.map((s) => basePlan(s))).size === 1;
        const targetEqualsBase = planIdsEqual(target.planId, modifyingSources[0]!.base?.planId ?? null);
        if (allSameBase && targetEqualsBase) {
            const first = modifyingSources[0]!;
            if (first.leg == null) {
                return buildConflict(slug, target, modifyingSources);
            }
            return {
                slug,
                kind: "unilateral_update",
                winning: first.leg,
                winningFrom: { sourceName: first.sourceName, prNumber: first.prNumber },
            };
        }
    }

    return buildConflict(slug, target, modifyingSources);
}

function buildConflict(
    slug: string,
    target: AssignmentRef | undefined,
    modifyingSources: ClassifierSource[],
    extraSources: ClassifierSource[] = [],
): Classification {
    const versions: ConflictVersion[] = [];
    if (target != null) versions.push({ role: "target-current", ref: target });

    const seenBases = new Set<string>();
    const baseFrom = modifyingSources.length > 0 ? modifyingSources : extraSources;
    for (const source of baseFrom) {
        if (source.base != null && !seenBases.has(source.base.assignmentId)) {
            seenBases.add(source.base.assignmentId);
            versions.push({ role: "target-base", ref: source.base });
        }
    }

    for (const source of modifyingSources) {
        if (source.leg == null) continue;
        versions.push({
            role: "source",
            sourceName: source.sourceName,
            prNumber: source.prNumber,
            ref: source.leg,
        });
    }

    return {
        slug,
        kind: "conflict",
        versions,
        involvedPrNumbers: modifyingSources.map((s) => s.prNumber),
    };
}

function legPlan(s: ClassifierSource): string | null {
    return s.leg?.planId ?? null;
}

function basePlan(s: ClassifierSource): string | null {
    return s.base?.planId ?? null;
}

function planIdsEqual(a: string | null, b: string | null): boolean {
    return a === b;
}

function tallyByKind(results: Classification[]): Record<string, number> {
    const counts: Record<string, number> = {
        unilateral_update: 0,
        new_test: 0,
        conflict: 0,
        no_change: 0,
    };
    for (const r of results) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
    return counts;
}
