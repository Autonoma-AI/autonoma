import type { SuiteAssignment } from "@autonoma/test-suite";
import { describe, expect, it } from "vitest";
import { buildMergeClassifierRows } from "../src/merge-classifier-rows";

const TARGET = "snap-target";
const SOURCE = "snap-source";
const BASE = "snap-base";

function assignment(snapshotId: string, slug: string, planId: string | null): SuiteAssignment {
    return {
        snapshotId,
        assignmentId: `assign-${snapshotId}-${slug}`,
        planId,
        testCaseId: `case-${slug}`,
        slug,
        testName: `Test ${slug}`,
    };
}

const source = { snapshotId: SOURCE, branchName: "feat/login", prNumber: 1, baseSnapshotId: BASE };

describe("buildMergeClassifierRows", () => {
    it("lines a test's target, source and merge-base legs up into one row", () => {
        const rows = buildMergeClassifierRows({
            assignments: [
                assignment(BASE, "login", "plan-v1"),
                assignment(SOURCE, "login", "plan-v2"),
                assignment(TARGET, "login", "plan-v1"),
            ],
            targetSnapshotId: TARGET,
            sources: [source],
        });

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            slug: "login",
            testCaseId: "case-login",
            testName: "Test login",
            target: { planId: "plan-v1" },
            sources: [
                { sourceName: "feat/login", prNumber: 1, leg: { planId: "plan-v2" }, base: { planId: "plan-v1" } },
            ],
        });
    });

    it("leaves a leg null where that snapshot does not assign the test", () => {
        const rows = buildMergeClassifierRows({
            assignments: [assignment(SOURCE, "signup", "plan-v1")],
            targetSnapshotId: TARGET,
            sources: [source],
        });

        expect(rows).toHaveLength(1);
        expect(rows[0]?.target).toBeNull();
        expect(rows[0]?.sources[0]?.base).toBeNull();
        expect(rows[0]?.sources[0]?.leg).toMatchObject({ planId: "plan-v1" });
    });

    it("leaves every base null when the source has no fork point to compare against", () => {
        const rows = buildMergeClassifierRows({
            assignments: [assignment(BASE, "login", "plan-v1"), assignment(SOURCE, "login", "plan-v2")],
            targetSnapshotId: TARGET,
            sources: [{ ...source, baseSnapshotId: null }],
        });

        expect(rows[0]?.sources[0]?.base).toBeNull();
    });

    it("drops a slug only the merge base holds, since no leg of the merge can be classified", () => {
        const rows = buildMergeClassifierRows({
            assignments: [assignment(BASE, "retired", "plan-v1"), assignment(TARGET, "login", "plan-v1")],
            targetSnapshotId: TARGET,
            sources: [source],
        });

        expect(rows.map((row) => row.slug)).toEqual(["login"]);
    });

    it("gives every source its own leg, so a multi-source merge classifies against all of them", () => {
        const other = { snapshotId: "snap-other", branchName: "feat/other", prNumber: 2, baseSnapshotId: BASE };
        const rows = buildMergeClassifierRows({
            assignments: [
                assignment(BASE, "login", "plan-v1"),
                assignment(SOURCE, "login", "plan-v2"),
                assignment("snap-other", "login", "plan-v3"),
            ],
            targetSnapshotId: TARGET,
            sources: [source, other],
        });

        expect(rows[0]?.sources.map((leg) => leg.leg?.planId)).toEqual(["plan-v2", "plan-v3"]);
    });

    it("carries a planless assignment through as a real leg rather than an absent one", () => {
        const rows = buildMergeClassifierRows({
            assignments: [assignment(TARGET, "login", null), assignment(SOURCE, "login", "plan-v2")],
            targetSnapshotId: TARGET,
            sources: [source],
        });

        expect(rows[0]?.target).toMatchObject({ planId: null });
    });
});
