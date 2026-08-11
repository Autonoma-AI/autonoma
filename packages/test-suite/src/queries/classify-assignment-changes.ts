/** One test's place in a diff of two snapshots' assignments, carrying whichever sides the diff found it on. */
export type AssignmentDiffEntry<T> =
    | { type: "added"; testCaseId: string; current: T }
    | { type: "updated"; testCaseId: string; current: T; previous: T }
    | { type: "removed"; testCaseId: string; previous: T };

/**
 * The one rule for what a snapshot changed relative to the snapshot it was opened from, diffed per
 * `testCaseId`:
 *
 * - Present in current, absent from previous -> added
 * - Present in both, different `planId` -> updated
 * - Absent from current, present in previous -> removed
 * - Same `planId` in both -> unchanged, omitted
 *
 * An absent `previous` means the snapshot was opened from nothing, so its whole suite is added.
 *
 * Generic over the assignment so both reads of this diff share the rule instead of restating it: the
 * batched summary passes rows holding only a plan id, the full change list passes rows carrying plan
 * prose. Membership is decided by key presence and never by the value, so an assignment with no plan
 * (`planId: null`) still counts as present - which is why `T` is an object rather than the id itself.
 *
 * Entries come out in map order, current first and the removals last, which is the order a caller
 * renders them in.
 */
export function classifyAssignmentChanges<T extends { planId: string | null }>(
    current: ReadonlyMap<string, T>,
    previous: ReadonlyMap<string, T> | undefined,
): AssignmentDiffEntry<T>[] {
    const entries: AssignmentDiffEntry<T>[] = [];

    for (const [testCaseId, currentAssignment] of current) {
        const previousAssignment = previous?.get(testCaseId);
        if (previousAssignment == null) {
            entries.push({ type: "added", testCaseId, current: currentAssignment });
        } else if (currentAssignment.planId !== previousAssignment.planId) {
            entries.push({ type: "updated", testCaseId, current: currentAssignment, previous: previousAssignment });
        }
    }

    if (previous != null) {
        for (const [testCaseId, previousAssignment] of previous) {
            if (!current.has(testCaseId)) {
                entries.push({ type: "removed", testCaseId, previous: previousAssignment });
            }
        }
    }

    return entries;
}
