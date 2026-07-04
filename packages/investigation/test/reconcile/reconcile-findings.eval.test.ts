import { describe, expect, it } from "vitest";
import { openModelSession, reconcileFindings } from "../../src";
import { aggregateScores, scorePairwise, type PairwiseScore } from "./cluster-metrics";
import { loadReconcileFixtures } from "./load-fixtures";

/**
 * The clustering evalset for the finding-reconciliation agent. Each fixture under ./fixtures is ONE real prod
 * shadow-investigation run (a single PR whose suite surfaced problems across many tests), de-identified: only
 * client-identifying proper nouns are genericized, so the technical shape - which findings truly share a cause
 * and which only look similar - is verbatim. The gold clustering was labelled by human-reviewed annotators WITHOUT
 * the reconcile agent (no circularity), and medium/low-confidence clusters are scored as don't-care.
 *
 * The set spans the shapes the agent meets in production:
 *  - MONOLITHIC recall: one huge obviously-shared cause (a preview that never deployed, an SDK that 404s, a seed
 *    endpoint that 500s) where every finding is one cluster - does it collapse them all to ONE?
 *  - PRECISION splits: two large clusters with near-identical boilerplate headlines but a genuinely different
 *    cause (HTTP 502 gateway vs HTTP 400 missing-factory; "app never rendered" vs "no seeded auth"; two DIFFERENT
 *    feature flags) - does it keep them apart instead of over-merging?
 *  - RICH mixed: several real clusters plus many singleton traps that share a feature area / slug prefix / category
 *    with a cluster but have a different cause - does it catch the real duplicates without absorbing the traps?
 *
 * Scored pairwise (see cluster-metrics.ts): precision is the SAFETY bar (a false merge hides a real, distinct
 * problem - worse than a missed duplicate), recall the VALUE bar (deduplication). Hits the live OpenAI API, so
 * RUN_EVALS=1 only:
 *   RUN_EVALS=1 pnpm --filter @autonoma/investigation exec vitest run test/reconcile/reconcile-findings.eval.test.ts
 */
const RUN = process.env.RUN_EVALS === "1" && process.env.OPENAI_API_KEY != null && process.env.OPENAI_API_KEY !== "";

// Calibrated against a live gpt-5.5 run over the 11-fixture set: measured P=100%, R=99.2%, F1=99.6%, zero
// cross-cluster merges. The agent is conservative - perfect precision, occasionally under-merging a cluster with
// internal variation. Thresholds sit below measured (with margin for model nondeterminism) so they catch a real
// regression - a false merge or a collapse in recall - rather than flaking on run-to-run noise.
const AGGREGATE_PRECISION_MIN = 0.97;
const AGGREGATE_RECALL_MIN = 0.9;
const AGGREGATE_F1_MIN = 0.93;
// The agent must never collapse two distinct high-confidence gold clusters into one merge (the dangerous mode).
const MAX_CROSS_CLUSTER_MERGES = 0;

const RECONCILE_MAX_STEPS = 40;
const EVAL_TIMEOUT_MS = 900_000;

function pct(n: number): string {
    return `${(n * 100).toFixed(1)}%`;
}

function reportLine(id: string, s: PairwiseScore): string {
    const cross = s.crossClusterMerges.length > 0 ? `  CROSS-MERGE x${s.crossClusterMerges.length}` : "";
    return (
        `  ${id.padEnd(34)} P=${pct(s.precision).padStart(6)} R=${pct(s.recall).padStart(6)} ` +
        `F1=${pct(s.f1).padStart(6)}  tp=${s.truePositives} fp=${s.falsePositives} fn=${s.falseNegatives}` +
        `  (scored ${s.scoredPairs}, skipped ${s.skippedPairs})${cross}`
    );
}

describe.skipIf(!RUN)("eval: finding reconciliation (gpt-5.5)", () => {
    it(
        "clusters real prod runs with high precision and strong recall across the eval set",
        async () => {
            const fixtures = loadReconcileFixtures();
            const model = openModelSession({ openaiApiKey: process.env.OPENAI_API_KEY ?? "" }).getModel({
                model: "classifier",
                tag: "eval-reconcile",
            });

            const scored = await Promise.all(
                fixtures.map(async (fixture) => {
                    const result = await reconcileFindings({
                        findings: fixture.findings,
                        model,
                        maxSteps: RECONCILE_MAX_STEPS,
                    });
                    const groups = result.merges.map((merge) => merge.memberIds);
                    return { fixture, groups, score: scorePairwise(fixture, groups) };
                }),
            );

            const aggregate = aggregateScores(scored.map((s) => s.score));

            const report =
                `\n[eval] finding reconciliation over ${fixtures.length} prod runs ` +
                `(${fixtures.reduce((n, f) => n + f.findings.length, 0)} findings):\n` +
                scored
                    .map(({ fixture, groups, score }) => {
                        const sizes = groups.map((g) => g.length).join(",");
                        return `${reportLine(fixture.id, score)}\n      merges: [${sizes}]`;
                    })
                    .join("\n") +
                `\n\n  AGGREGATE  P=${pct(aggregate.precision)} R=${pct(aggregate.recall)} ` +
                `F1=${pct(aggregate.f1)}  tp=${aggregate.truePositives} fp=${aggregate.falsePositives} ` +
                `fn=${aggregate.falseNegatives}  cross-cluster merges=${aggregate.crossClusterMerges.length}\n`;

            // eslint-disable-next-line no-console
            console.log(report);
            const outPath = process.env.RECONCILE_EVAL_OUT;
            if (outPath != null && outPath !== "") {
                const { writeFileSync } = await import("node:fs");
                writeFileSync(outPath, report);
            }

            for (const { fixture, score } of scored) {
                expect(
                    score.crossClusterMerges.length,
                    `${fixture.id} merged distinct gold clusters: ${JSON.stringify(score.crossClusterMerges)}`,
                ).toBeLessThanOrEqual(MAX_CROSS_CLUSTER_MERGES);
            }

            expect(aggregate.precision).toBeGreaterThanOrEqual(AGGREGATE_PRECISION_MIN);
            expect(aggregate.recall).toBeGreaterThanOrEqual(AGGREGATE_RECALL_MIN);
            expect(aggregate.f1).toBeGreaterThanOrEqual(AGGREGATE_F1_MIN);
        },
        EVAL_TIMEOUT_MS,
    );
});
