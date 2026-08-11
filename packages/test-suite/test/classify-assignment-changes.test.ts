import { describe, expect, it } from "vitest";
import { classifyAssignmentChanges } from "../src/queries/classify-assignment-changes";

/** Assignments keyed the way both callers key them: test case id -> the row carrying its plan id. */
function assignments(entries: Record<string, string | null>): Map<string, { planId: string | null }> {
    return new Map(Object.entries(entries).map(([testCaseId, planId]) => [testCaseId, { planId }]));
}

describe("classifyAssignmentChanges", () => {
    it("reports a test the snapshot assigns and its source did not as added", () => {
        const changes = classifyAssignmentChanges(assignments({ a: "plan-1" }), assignments({}));

        expect(changes).toEqual([{ type: "added", testCaseId: "a", current: { planId: "plan-1" } }]);
    });

    it("reports a repointed assignment as updated and an untouched one not at all", () => {
        const changes = classifyAssignmentChanges(
            assignments({ moved: "plan-2", same: "plan-9" }),
            assignments({ moved: "plan-1", same: "plan-9" }),
        );

        expect(changes.map((change) => [change.type, change.testCaseId])).toEqual([["updated", "moved"]]);
    });

    it("reports a test the source assigned and the snapshot dropped as removed", () => {
        const changes = classifyAssignmentChanges(assignments({}), assignments({ gone: "plan-1" }));

        expect(changes).toEqual([{ type: "removed", testCaseId: "gone", previous: { planId: "plan-1" } }]);
    });

    // Membership is the map key, never the value. Deciding it on the value would read an assignment
    // carrying no plan as absent, and report a test that never moved as added on every diff.
    it("treats an assignment with no plan as present on both sides", () => {
        const unchanged = classifyAssignmentChanges(assignments({ a: null }), assignments({ a: null }));
        expect(unchanged).toEqual([]);

        const planted = classifyAssignmentChanges(assignments({ a: "plan-1" }), assignments({ a: null }));
        expect(planted.map((change) => change.type)).toEqual(["updated"]);
    });

    it("treats a snapshot opened from nothing as having added its whole suite", () => {
        const changes = classifyAssignmentChanges(assignments({ a: "plan-1", b: null }), undefined);

        expect(changes.map((change) => change.type)).toEqual(["added", "added"]);
    });

    // The order a caller renders: what the snapshot has now, then what it dropped.
    it("orders the snapshot's own tests before its removals", () => {
        const changes = classifyAssignmentChanges(
            assignments({ kept: "plan-2", fresh: "plan-3" }),
            assignments({ kept: "plan-1", dropped: "plan-4" }),
        );

        expect(changes.map((change) => [change.type, change.testCaseId])).toEqual([
            ["updated", "kept"],
            ["added", "fresh"],
            ["removed", "dropped"],
        ]);
    });
});
