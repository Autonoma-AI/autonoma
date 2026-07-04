/**
 * Pairwise clustering metrics for the finding-reconciliation eval.
 *
 * The agent's job is a partition: which findings describe the SAME underlying cause. We score that partition the
 * standard way for clustering - over unordered PAIRS of findings - because it needs no alignment between the
 * agent's cluster ids and the gold cluster ids:
 *   - a pair is a gold-positive if both findings sit in the same HIGH-confidence gold cluster;
 *   - a pair is predicted-positive if the agent merged both findings into one group.
 * Precision = of the pairs the agent merged, how many truly share a cause (the SAFETY metric - a false merge hides
 * a real, distinct problem). Recall = of the pairs that truly share a cause, how many the agent caught (the VALUE
 * metric - deduplication). F1 balances them.
 *
 * DON'T-CARE tier: gold clusters the human annotator marked medium/low confidence are genuinely ambiguous, so any
 * pair touching one is EXCLUDED from scoring - the agent is neither rewarded nor penalised for a defensible call.
 * Only high-confidence memberships and singletons (confidently distinct) are scored. This keeps thresholds honest.
 */

const HIGH_CONFIDENCE = "high";

export interface GoldCluster {
    members: string[];
    confidence: string;
}

export interface ClusterFixture {
    id: string;
    findings: { id: string }[];
    gold: GoldCluster[];
}

export interface PairwiseScore {
    truePositives: number;
    falsePositives: number;
    falseNegatives: number;
    scoredPairs: number;
    skippedPairs: number;
    precision: number;
    recall: number;
    f1: number;
    /** The dangerous subset of false positives: merged pairs where each side belongs to a DIFFERENT high gold cluster (two real, distinct problems collapsed into one). */
    crossClusterMerges: [string, string][];
}

interface GoldIndex {
    /** finding id -> high-confidence cluster label (absent for singletons and ambiguous members). */
    highLabel: Map<string, string>;
    /** finding ids belonging to a medium/low gold cluster - excluded from scoring. */
    ambiguous: Set<string>;
}

function indexGold(gold: GoldCluster[]): GoldIndex {
    const highLabel = new Map<string, string>();
    const ambiguous = new Set<string>();
    gold.forEach((cluster, i) => {
        const isHigh = cluster.confidence === HIGH_CONFIDENCE;
        for (const id of cluster.members) {
            if (isHigh) {
                highLabel.set(id, `gold-${i}`);
                continue;
            }
            ambiguous.add(id);
        }
    });
    return { highLabel, ambiguous };
}

/** Build a "same predicted group" lookup from the agent's merges (each an array of member ids). */
function predictedTogether(mergedGroups: string[][]): (a: string, b: string) => boolean {
    const groupOf = new Map<string, number>();
    mergedGroups.forEach((group, i) => {
        for (const id of group) groupOf.set(id, i);
    });
    return (a, b) => {
        const ga = groupOf.get(a);
        return ga != null && ga === groupOf.get(b);
    };
}

function f1Score(precision: number, recall: number): number {
    if (precision + recall === 0) return 0;
    return (2 * precision * recall) / (precision + recall);
}

/**
 * Score the agent's partition of one fixture. `mergedGroups` is the agent's output as arrays of finding ids
 * (typically `result.merges.map((m) => m.memberIds)`); findings not in any group are treated as singletons.
 */
export function scorePairwise(fixture: ClusterFixture, mergedGroups: string[][]): PairwiseScore {
    const { highLabel, ambiguous } = indexGold(fixture.gold);
    const together = predictedTogether(mergedGroups);
    const ids = fixture.findings.map((f) => f.id);

    let truePositives = 0;
    let falsePositives = 0;
    let falseNegatives = 0;
    let skippedPairs = 0;
    const crossClusterMerges: [string, string][] = [];

    for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
            const a = ids[i]!;
            const b = ids[j]!;
            if (ambiguous.has(a) || ambiguous.has(b)) {
                skippedPairs++;
                continue;
            }
            const labelA = highLabel.get(a);
            const labelB = highLabel.get(b);
            const goldPositive = labelA != null && labelA === labelB;
            const predictedPositive = together(a, b);

            if (goldPositive && predictedPositive) truePositives++;
            else if (goldPositive && !predictedPositive) falseNegatives++;
            else if (!goldPositive && predictedPositive) {
                falsePositives++;
                const bothInDistinctClusters = labelA != null && labelB != null && labelA !== labelB;
                if (bothInDistinctClusters) crossClusterMerges.push([a, b]);
            }
        }
    }

    const scoredPairs = truePositives + falsePositives + falseNegatives;
    const precision = truePositives + falsePositives === 0 ? 1 : truePositives / (truePositives + falsePositives);
    const recall = truePositives + falseNegatives === 0 ? 1 : truePositives / (truePositives + falseNegatives);

    return {
        truePositives,
        falsePositives,
        falseNegatives,
        scoredPairs,
        skippedPairs,
        precision,
        recall,
        f1: f1Score(precision, recall),
        crossClusterMerges,
    };
}

/** Micro-average across cases: sum the pair counts, then derive precision/recall/F1 from the totals. */
export function aggregateScores(scores: PairwiseScore[]): PairwiseScore {
    const truePositives = scores.reduce((s, x) => s + x.truePositives, 0);
    const falsePositives = scores.reduce((s, x) => s + x.falsePositives, 0);
    const falseNegatives = scores.reduce((s, x) => s + x.falseNegatives, 0);
    const skippedPairs = scores.reduce((s, x) => s + x.skippedPairs, 0);
    const crossClusterMerges = scores.flatMap((x) => x.crossClusterMerges);
    const precision = truePositives + falsePositives === 0 ? 1 : truePositives / (truePositives + falsePositives);
    const recall = truePositives + falseNegatives === 0 ? 1 : truePositives / (truePositives + falseNegatives);
    return {
        truePositives,
        falsePositives,
        falseNegatives,
        scoredPairs: truePositives + falsePositives + falseNegatives,
        skippedPairs,
        precision,
        recall,
        f1: f1Score(precision, recall),
        crossClusterMerges,
    };
}
