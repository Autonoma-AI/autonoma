import { describe, expect, it } from "vitest";
import { buildReportMarkdown } from "../../src/report/markdown";

describe("buildReportMarkdown", () => {
    it("leads with the one-liner + summary + remediation, and collapses root cause/evidence/diff", () => {
        const markdown = buildReportMarkdown({
            client: "Centinel",
            appSlug: "centinel-app",
            prNumber: 1680,
            prTitle: "fix audit panel",
            prBody: "the details",
            tests: [
                {
                    slug: "audit-panel",
                    plan: "Steps:\n1. assert: row is hidden",
                    runSuccess: false,
                    stepCount: 5,
                    videoUrl: "https://s3/video",
                    finalScreenshotUrl: "https://s3/shot",
                    verdicts: [
                        {
                            model: "investigation",
                            verdict: {
                                category: "scenario_issue",
                                confidence: "high",
                                planFidelity: "diverged",
                                headline: "Audit panel shows no rows",
                                falsePositiveRisk: "low",
                                whatHappened: "no data on screen",
                                rootCause: "recipe gap",
                                remediation: "seed it",
                                suggestedTestUpdate: "Steps:\n1. assert: row is visible",
                                evidence: [
                                    {
                                        source: "code",
                                        detail: "no seed",
                                        file: "autonoma/recipe.json",
                                        lines: "10-12",
                                        snippet: "{}",
                                    },
                                ],
                            },
                        },
                    ],
                },
            ],
            suggested: [
                {
                    name: "Multi-language guard",
                    instruction: "Setup:\n- on the page\nSteps:\n1. type: hi",
                    reasoning: "new ES/PT handling no test covers",
                    validation: { passed: true, iterations: 2 },
                },
            ],
            quarantine: [{ slug: "legacy-export", reason: "the export route was deleted" }],
            deployed: {
                found: true,
                jobStatus: "completed",
                analysisReasoning: "touches the audit panel",
                perTest: [
                    {
                        testSlug: "audit-panel",
                        affectedReason: "code_change",
                        runStatus: "failed",
                        generatedFix: false,
                    },
                ],
            },
        });

        // one-liner heading + metadata subline + summary + remediation (top-level, skimmable)
        expect(markdown).toContain("## Audit panel shows no rows");
        expect(markdown).toContain("`audit-panel` · **scenario_issue** · high confidence");
        expect(markdown).toContain("no data on screen");
        expect(markdown).toContain("**Remediation:** seed it");
        expect(markdown).toContain("[run video](https://s3/video)");
        // deep dive collapsed
        expect(markdown).toContain("<summary>Root cause &amp; evidence</summary>");
        expect(markdown).toContain("`autonoma/recipe.json:10-12`");
        // suggested update rendered as a diff
        expect(markdown).toContain("```diff");
        expect(markdown).toContain("-1. assert: row is hidden");
        expect(markdown).toContain("+1. assert: row is visible");
        // PR body collapsed, not a raw fence; model name not in the heading
        expect(markdown).toContain("**PR #1680:** fix audit panel");
        expect(markdown).toContain("<summary>PR description</summary>");
        expect(markdown).not.toContain("investigation - scenario_issue");
        // proposed new test + validation badge + quarantine recommendation
        expect(markdown).toContain("## Proposed new tests");
        expect(markdown).toContain("### Multi-language guard");
        expect(markdown).toContain("✓ **validated** - passes after 2 iteration(s)");
        expect(markdown).toContain("## Quarantine recommendations");
        expect(markdown).toContain("`legacy-export` - the export route was deleted");
    });

    it("handles a not-found deployed comparison and a classification error", () => {
        const markdown = buildReportMarkdown({
            client: "Homa",
            appSlug: "homa-next",
            prNumber: 1,
            tests: [
                { slug: "t", plan: "p", runSuccess: true, stepCount: 1, verdicts: [{ model: "m", error: "boom" }] },
            ],
            suggested: [],
            quarantine: [],
            deployed: { found: false, perTest: [] },
        });

        expect(markdown).toContain("No run found for this PR by the deployed agent");
        expect(markdown).toContain("## t - classification error");
        expect(markdown).toContain("boom");
    });
});
