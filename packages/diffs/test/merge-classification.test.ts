import { describe, expect, it } from "vitest";
import {
    type AssignmentRef,
    type ClassifierSource,
    type Classification,
    type ClassifyTestInput,
    classifyTestsForMerge,
} from "../src/merge-classification";

function ref(assignmentId: string, planId: string | null): AssignmentRef {
    return { assignmentId, planId };
}

function source(
    sourceName: string,
    prNumber: number,
    leg: AssignmentRef | null,
    base: AssignmentRef | null,
): ClassifierSource {
    return { sourceName, prNumber, leg, base };
}

function classifyOne(input: ClassifyTestInput): Classification | undefined {
    const result = classifyTestsForMerge([input]);
    return result[0];
}

describe("classifyTestsForMerge", () => {
    describe("single-source (feat/x -> main)", () => {
        it("case D: nobody modified", () => {
            const target = ref("t1", "plan-v1");
            const result = classifyOne({
                slug: "a",
                target,
                sources: [source("feat", 1, ref("s1", "plan-v1"), ref("b1", "plan-v1"))],
            });
            expect(result).toEqual({ slug: "a", kind: "no_change" });
        });

        it("case A with target winning: only main modified", () => {
            const target = ref("t1", "plan-v2");
            const result = classifyOne({
                slug: "a",
                target,
                sources: [source("feat", 1, ref("s1", "plan-v1"), ref("b1", "plan-v1"))],
            });
            expect(result).toEqual({
                slug: "a",
                kind: "unilateral_update",
                winning: target,
                winningFrom: "target",
            });
        });

        it("case A with source winning: only source modified", () => {
            const srcLeg = ref("s1", "plan-v2");
            const result = classifyOne({
                slug: "a",
                target: ref("t1", "plan-v1"),
                sources: [source("feat", 1, srcLeg, ref("b1", "plan-v1"))],
            });
            expect(result).toEqual({
                slug: "a",
                kind: "unilateral_update",
                winning: srcLeg,
                winningFrom: { sourceName: "feat", prNumber: 1 },
            });
        });

        it("case C: main and source both modified, different plans", () => {
            const result = classifyOne({
                slug: "a",
                target: ref("t1", "plan-main2"),
                sources: [source("feat", 1, ref("s1", "plan-feat2"), ref("b1", "plan-v1"))],
            });
            expect(result?.kind).toBe("conflict");
            if (result?.kind !== "conflict") throw new Error("not conflict");
            expect(result.involvedPrNumbers).toEqual([1]);
            expect(result.versions).toContainEqual({ role: "target-current", ref: ref("t1", "plan-main2") });
            expect(result.versions).toContainEqual({ role: "target-base", ref: ref("b1", "plan-v1") });
            expect(result.versions).toContainEqual({
                role: "source",
                sourceName: "feat",
                prNumber: 1,
                ref: ref("s1", "plan-feat2"),
            });
        });

        it("case D on convergence: main and source both modified to same plan", () => {
            const result = classifyOne({
                slug: "a",
                target: ref("t1", "plan-v2"),
                sources: [source("feat", 1, ref("s1", "plan-v2"), ref("b1", "plan-v1"))],
            });
            expect(result).toEqual({ slug: "a", kind: "no_change" });
        });

        it("case B: new test on source", () => {
            const srcLeg = ref("s1", "plan-new");
            const result = classifyOne({
                slug: "a",
                target: null,
                sources: [source("feat", 1, srcLeg, null)],
            });
            expect(result).toEqual({
                slug: "a",
                kind: "new_test",
                newAssignment: srcLeg,
                winningFrom: { sourceName: "feat", prNumber: 1 },
            });
        });

        it("case C: quarantine on source, main modified (quarantine_vs_edit collapsed in Phase 1)", () => {
            const result = classifyOne({
                slug: "a",
                target: ref("t1", "plan-main2"),
                sources: [source("feat", 1, null, ref("b1", "plan-v1"))],
            });
            expect(result?.kind).toBe("conflict");
            if (result?.kind !== "conflict") throw new Error("not conflict");
            expect(result.involvedPrNumbers).toEqual([1]);
            expect(result.versions).toContainEqual({ role: "target-current", ref: ref("t1", "plan-main2") });
            expect(result.versions).toContainEqual({ role: "target-base", ref: ref("b1", "plan-v1") });
            expect(result.versions.some((v) => v.role === "source")).toBe(false);
        });

        it("case C: source modified, main quarantined the test (target planId=null)", () => {
            const result = classifyOne({
                slug: "a",
                target: ref("t1", null),
                sources: [source("feat", 1, ref("s1", "plan-feat2"), ref("b1", "plan-v1"))],
            });
            expect(result?.kind).toBe("conflict");
        });

        it("skips when test is absent from target and all sources", () => {
            const result = classifyOne({
                slug: "a",
                target: null,
                sources: [source("feat", 1, null, null)],
            });
            expect(result).toBeUndefined();
        });

        it("does not produce B when source leg matches its base (source did not actually add it)", () => {
            const result = classifyOne({
                slug: "a",
                target: null,
                sources: [source("feat", 1, ref("s1", "plan-v1"), ref("b1", "plan-v1"))],
            });
            expect(result).toEqual({ slug: "a", kind: "no_change" });
        });

        it("handles a source that neither added nor modified by collapsing to D", () => {
            const result = classifyOne({
                slug: "a",
                target: ref("t1", "plan-v1"),
                sources: [
                    source("feat", 1, ref("s1", "plan-v1"), ref("b1", "plan-v1")),
                    source("feat2", 2, null, null),
                ],
            });
            expect(result).toEqual({ slug: "a", kind: "no_change" });
        });

        it("target matches source leg even though both moved away from base -> D", () => {
            const result = classifyOne({
                slug: "a",
                target: ref("t1", "plan-v2"),
                sources: [source("feat", 1, ref("s1", "plan-v2"), ref("b1", "plan-v1"))],
            });
            expect(result).toEqual({ slug: "a", kind: "no_change" });
        });
    });

    describe("accumulated merges (multiple sources)", () => {
        it("case A: one source modified, other inert, main unchanged", () => {
            const winning = ref("s1", "plan-v2");
            const result = classifyOne({
                slug: "a",
                target: ref("t1", "plan-v1"),
                sources: [
                    source("feat-a", 1, winning, ref("b1", "plan-v1")),
                    source("feat-b", 2, ref("s2", "plan-v1"), ref("b2", "plan-v1")),
                ],
            });
            expect(result).toEqual({
                slug: "a",
                kind: "unilateral_update",
                winning,
                winningFrom: { sourceName: "feat-a", prNumber: 1 },
            });
        });

        it("case C N-way: two sources modified the same test with divergent plans", () => {
            const result = classifyOne({
                slug: "a",
                target: ref("t1", "plan-v1"),
                sources: [
                    source("feat-a", 1, ref("s1", "plan-a"), ref("b1", "plan-v1")),
                    source("feat-b", 2, ref("s2", "plan-b"), ref("b2", "plan-v1")),
                ],
            });
            expect(result?.kind).toBe("conflict");
            if (result?.kind !== "conflict") throw new Error("not conflict");
            expect(result.involvedPrNumbers.sort()).toEqual([1, 2]);
            expect(result.versions.filter((v) => v.role === "source")).toHaveLength(2);
        });

        it("case C: 2 sources modified (agree), main also moved in a different direction", () => {
            const result = classifyOne({
                slug: "a",
                target: ref("t1", "plan-main2"),
                sources: [
                    source("feat-a", 1, ref("s1", "plan-feat"), ref("b1", "plan-v1")),
                    source("feat-b", 2, ref("s2", "plan-feat"), ref("b2", "plan-v1")),
                ],
            });
            expect(result?.kind).toBe("conflict");
            if (result?.kind !== "conflict") throw new Error("not conflict");
            expect(result.involvedPrNumbers.sort()).toEqual([1, 2]);
        });

        it("case D: N sources converge and main matches", () => {
            const result = classifyOne({
                slug: "a",
                target: ref("t1", "plan-v2"),
                sources: [
                    source("feat-a", 1, ref("s1", "plan-v2"), ref("b1", "plan-v1")),
                    source("feat-b", 2, ref("s2", "plan-v2"), ref("b2", "plan-v1")),
                ],
            });
            expect(result).toEqual({ slug: "a", kind: "no_change" });
        });

        it("case A: 2 sources converge to same new plan, main untouched", () => {
            const winning = ref("s1", "plan-v2");
            const result = classifyOne({
                slug: "a",
                target: ref("t1", "plan-v1"),
                sources: [
                    source("feat-a", 1, winning, ref("b1", "plan-v1")),
                    source("feat-b", 2, ref("s2", "plan-v2"), ref("b2", "plan-v1")),
                ],
            });
            expect(result?.kind).toBe("unilateral_update");
        });

        it("case B N-way degenerates to C when sources disagree on a new test", () => {
            const result = classifyOne({
                slug: "a",
                target: null,
                sources: [
                    source("feat-a", 1, ref("s1", "plan-a"), null),
                    source("feat-b", 2, ref("s2", "plan-b"), null),
                ],
            });
            expect(result?.kind).toBe("conflict");
            if (result?.kind !== "conflict") throw new Error("not conflict");
            expect(result.involvedPrNumbers.sort()).toEqual([1, 2]);
        });

        it("case B: two sources agree on a new test with the same plan", () => {
            const result = classifyOne({
                slug: "a",
                target: null,
                sources: [
                    source("feat-a", 1, ref("s1", "plan-new"), null),
                    source("feat-b", 2, ref("s2", "plan-new"), null),
                ],
            });
            expect(result?.kind).toBe("new_test");
        });
    });

    describe("batch behaviour", () => {
        it("filters out null (skipped) slugs and preserves order", () => {
            const results = classifyTestsForMerge([
                { slug: "skip-me", target: null, sources: [source("feat", 1, null, null)] },
                {
                    slug: "d-case",
                    target: ref("t1", "plan-v1"),
                    sources: [source("feat", 1, ref("s1", "plan-v1"), ref("b1", "plan-v1"))],
                },
                {
                    slug: "a-case",
                    target: ref("t2", "plan-v1"),
                    sources: [source("feat", 1, ref("s2", "plan-v2"), ref("b2", "plan-v1"))],
                },
            ]);
            expect(results.map((r) => r.slug)).toEqual(["d-case", "a-case"]);
            expect(results.map((r) => r.kind)).toEqual(["no_change", "unilateral_update"]);
        });
    });
});
