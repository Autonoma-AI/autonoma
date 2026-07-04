import { describe, expect, it } from "vitest";
import { aggregateScores, scorePairwise, type ClusterFixture } from "./cluster-metrics";

/** A fixture with two high clusters {a,b,c} and {d,e}, plus singletons f, g. */
function fixture(gold: ClusterFixture["gold"]): ClusterFixture {
    return {
        id: "synthetic",
        findings: ["a", "b", "c", "d", "e", "f", "g"].map((id) => ({ id })),
        gold,
    };
}

const TWO_HIGH_CLUSTERS: ClusterFixture["gold"] = [
    { members: ["a", "b", "c"], confidence: "high" },
    { members: ["d", "e"], confidence: "high" },
];

describe("scorePairwise", () => {
    it("is perfect when the agent reproduces the gold partition exactly", () => {
        const s = scorePairwise(fixture(TWO_HIGH_CLUSTERS), [
            ["a", "b", "c"],
            ["d", "e"],
        ]);
        // gold-positive pairs: ab, ac, bc (cluster 1) + de (cluster 2) = 4 true positives, no misses, no bad merges.
        expect(s.truePositives).toBe(4);
        expect(s.falsePositives).toBe(0);
        expect(s.falseNegatives).toBe(0);
        expect(s.precision).toBe(1);
        expect(s.recall).toBe(1);
        expect(s.f1).toBe(1);
        expect(s.crossClusterMerges).toEqual([]);
    });

    it("counts missed duplicates as false negatives (recall drops, precision stays perfect)", () => {
        // Agent only caught a+b, missed c and the whole {d,e} cluster.
        const s = scorePairwise(fixture(TWO_HIGH_CLUSTERS), [["a", "b"]]);
        expect(s.truePositives).toBe(1); // ab
        expect(s.falseNegatives).toBe(3); // ac, bc, de
        expect(s.falsePositives).toBe(0);
        expect(s.precision).toBe(1);
        expect(s.recall).toBeCloseTo(1 / 4);
    });

    it("flags a merge across two distinct high clusters as a cross-cluster false positive", () => {
        const s = scorePairwise(fixture(TWO_HIGH_CLUSTERS), [["a", "b", "c", "d", "e"]]);
        // ad, ae, bd, be, cd, ce are false merges across clusters (6); ab, ac, bc, de remain true positives (4).
        expect(s.truePositives).toBe(4);
        expect(s.falsePositives).toBe(6);
        expect(s.crossClusterMerges).toHaveLength(6);
    });

    it("penalises absorbing a singleton as a plain false positive, not a cross-cluster merge", () => {
        const s = scorePairwise(fixture(TWO_HIGH_CLUSTERS), [["a", "b", "c", "f"]]);
        // af, bf, cf are false positives but f is a singleton, so none is a cross-cluster merge.
        expect(s.falsePositives).toBe(3);
        expect(s.crossClusterMerges).toEqual([]);
    });

    it("excludes any pair touching a medium/low-confidence cluster from scoring (don't-care)", () => {
        const gold: ClusterFixture["gold"] = [
            { members: ["a", "b", "c"], confidence: "high" },
            { members: ["d", "e"], confidence: "medium" },
        ];
        // Agent merges the high cluster correctly AND merges the ambiguous d+e; d,e pairs are all skipped.
        const s = scorePairwise(fixture(gold), [
            ["a", "b", "c"],
            ["d", "e"],
        ]);
        expect(s.truePositives).toBe(3); // ab, ac, bc
        expect(s.falsePositives).toBe(0); // de and every pair involving d or e is don't-care
        expect(s.precision).toBe(1);
        expect(s.recall).toBe(1);
        expect(s.skippedPairs).toBeGreaterThan(0);
    });

    it("treats no merges as vacuously precise with zero recall when gold has duplicates", () => {
        const s = scorePairwise(fixture(TWO_HIGH_CLUSTERS), []);
        expect(s.truePositives).toBe(0);
        expect(s.falsePositives).toBe(0);
        expect(s.precision).toBe(1);
        expect(s.recall).toBe(0);
    });
});

describe("aggregateScores", () => {
    it("micro-averages pair counts across cases", () => {
        const perfect = scorePairwise(fixture(TWO_HIGH_CLUSTERS), [
            ["a", "b", "c"],
            ["d", "e"],
        ]);
        const missed = scorePairwise(fixture(TWO_HIGH_CLUSTERS), [["a", "b"]]);
        const agg = aggregateScores([perfect, missed]);
        expect(agg.truePositives).toBe(5); // 4 + 1
        expect(agg.falseNegatives).toBe(3); // 0 + 3
        expect(agg.falsePositives).toBe(0);
        expect(agg.recall).toBeCloseTo(5 / 8);
        expect(agg.precision).toBe(1);
    });
});
