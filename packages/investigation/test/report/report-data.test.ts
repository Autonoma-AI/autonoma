import { investigationReportDataSchema } from "@autonoma/types";
import { describe, expect, it } from "vitest";
import { buildReportMarkdown, type InvestigationReportInput } from "../../src/report/markdown";
import { parseReportMarkdown } from "../../src/report/parse-markdown";
import { buildReportData } from "../../src/report/report-data";

const INPUT: InvestigationReportInput = {
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
            runSteps: ["1. [click filter] success", "2. [assert row hidden] failed - ERROR: row still visible"],
            videoUrl: "s3://autonoma-assets/test-generation/run-1/video.webm",
            finalScreenshotUrl: "s3://autonoma-assets/test-generation/run-1/final-screenshot.png",
            verdicts: [
                {
                    model: "investigation",
                    verdict: {
                        category: "client_bug",
                        confidence: "high",
                        planFidelity: "exact",
                        headline: "Audit panel shows no rows after the change",
                        falsePositiveRisk: "low - intent was unrelated",
                        whatHappened: "the panel stayed empty after applying the filter",
                        observedAppIssues: "empty table where rows were expected",
                        rootCause: "the query drops the tenant filter",
                        remediation: "restore the tenant scope",
                        evidence: [
                            {
                                source: "code",
                                detail: "the filter is missing here",
                                file: "apps/audit/query.ts",
                                lines: "10-12",
                                snippet: "select().from(rows)",
                            },
                            { source: "run", detail: "no prior baseline" },
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
    deployed: { found: true, jobStatus: "completed", analysisReasoning: "touches the audit panel", perTest: [] },
};

describe("buildReportData", () => {
    it("projects the structured input into flat findings the UI consumes", () => {
        const data = buildReportData(INPUT);
        expect(data.appSlug).toBe("centinel-app");
        expect(data.prNumber).toBe(1680);
        expect(data.findings).toHaveLength(1);
        const finding = data.findings[0];
        expect(finding?.id).toBe("audit-panel");
        expect(finding?.category).toBe("client_bug");
        expect(finding?.headline).toBe("Audit panel shows no rows after the change");
        expect(finding?.finalScreenshotUrl).toContain("final-screenshot.png");
        expect(finding?.evidence).toHaveLength(2);
        expect(finding?.evidence[0]?.file).toBe("apps/audit/query.ts");
        // the run trace (the agent's own step-by-step observation log) is carried into the finding so a
        // reader can audit the verdict against what actually happened, not just the narrative.
        expect(finding?.runSteps).toContain("2. [assert row hidden] failed - ERROR: row still visible");
        expect(data.suggested[0]?.name).toBe("Multi-language guard");
    });

    it("produces JSON that validates against the shared API/UI schema (both build paths)", () => {
        expect(() => investigationReportDataSchema.parse(buildReportData(INPUT))).not.toThrow();
        expect(() =>
            investigationReportDataSchema.parse(parseReportMarkdown(buildReportMarkdown(INPUT))),
        ).not.toThrow();
    });

    it("carries the scenario-repair diagnosis onto the finding as evidence pieces", () => {
        const withDiagnosis: InvestigationReportInput = {
            ...INPUT,
            tests: [
                {
                    ...INPUT.tests[0]!,
                    scenarioDiagnosis: {
                        route: "recipe_only",
                        confidence: "high",
                        reasoning: "the seeded tenant has no invoices, so the audit panel is legitimately empty",
                        recipeChange: "add a paid invoice for the tenant",
                        proposedRecipeSummary: "seed one paid invoice",
                        proposedRecipeCreateGraph: '{"invoice":{"_factory":"invoice"}}',
                        applied: true,
                        appliedNote: "re-ran green on the twin",
                    },
                },
            ],
        };
        const finding = buildReportData(withDiagnosis).findings[0];

        const repair = finding?.evidence.find((e) => e.source === "scenario repair");
        expect(repair?.detail).toContain("Edit the scenario recipe");
        expect(repair?.detail).toContain("the seeded tenant has no invoices");

        const recipe = finding?.evidence.find((e) => e.source === "recipe change");
        expect(recipe?.detail).toContain("seed one paid invoice");
        expect(recipe?.snippet).toContain('"invoice"');

        const autofix = finding?.evidence.find((e) => e.source === "autofix");
        expect(autofix?.detail).toContain("validated on the twin");
        expect(autofix?.detail).toContain("re-ran green on the twin");

        // The original verdict evidence is preserved alongside the diagnosis evidence.
        expect(finding?.evidence.some((e) => e.source === "code")).toBe(true);
    });

    it("attaches the per-test scenario diagnosis to exactly one finding, not to every model verdict", () => {
        const baseVerdict = INPUT.tests[0]!.verdicts[0]!;
        const multiModel: InvestigationReportInput = {
            ...INPUT,
            tests: [
                {
                    ...INPUT.tests[0]!,
                    // two model verdicts for the SAME test -> two findings (slug, slug-2)
                    verdicts: [baseVerdict, { model: "second-model", verdict: baseVerdict.verdict }],
                    scenarioDiagnosis: {
                        route: "recipe_only",
                        confidence: "high",
                        reasoning: "the seeded tenant has no invoices",
                        recipeChange: "add a paid invoice for the tenant",
                        applied: true,
                    },
                },
            ],
        };
        const findings = buildReportData(multiModel).findings;
        expect(findings).toHaveLength(2);

        const withDiagnosis = findings.filter((f) => f.evidence.some((e) => e.source === "scenario repair"));
        expect(withDiagnosis).toHaveLength(1);
        // it lands on the first finding for the test, not the trailing one
        expect(withDiagnosis[0]?.id).toBe("audit-panel");
    });

    it("renders a suggested test fix as a unified diff string", () => {
        const withFix: InvestigationReportInput = {
            ...INPUT,
            tests: [
                {
                    ...INPUT.tests[0]!,
                    verdicts: [
                        {
                            model: "investigation",
                            verdict: {
                                ...INPUT.tests[0]!.verdicts[0]!.verdict!,
                                suggestedTestUpdate: "Steps:\n1. assert: row is visible",
                            },
                        },
                    ],
                },
            ],
        };
        const finding = buildReportData(withFix).findings[0];
        expect(finding?.suggestedFixDiff).toContain("-1. assert: row is hidden");
        expect(finding?.suggestedFixDiff).toContain("+1. assert: row is visible");
    });
});

describe("parseReportMarkdown (round-trips the rendered markdown)", () => {
    it("recovers the core finding fields the renderer emitted", () => {
        const parsed = parseReportMarkdown(buildReportMarkdown(INPUT));
        expect(parsed.appSlug).toBe("centinel-app");
        expect(parsed.prNumber).toBe(1680);
        expect(parsed.prTitle).toBe("fix audit panel");

        const finding = parsed.findings.find((f) => f.slug === "audit-panel");
        expect(finding).toBeDefined();
        expect(finding?.id).toBe("audit-panel");
        expect(finding?.category).toBe("client_bug");
        expect(finding?.confidence).toBe("high");
        expect(finding?.planFidelity).toBe("exact");
        expect(finding?.whatHappened).toContain("stayed empty after applying the filter");
        expect(finding?.observedAppIssues).toContain("empty table");
        expect(finding?.remediation).toContain("restore the tenant scope");
        expect(finding?.rootCause).toContain("drops the tenant filter");
        expect(finding?.falsePositiveRisk).toContain("intent was unrelated");
        expect(finding?.finalScreenshotUrl).toBe("s3://autonoma-assets/test-generation/run-1/final-screenshot.png");
        expect(finding?.videoUrl).toBe("s3://autonoma-assets/test-generation/run-1/video.webm");
        expect(finding?.evidence.length).toBeGreaterThanOrEqual(2);
        const codeEvidence = finding?.evidence.find((e) => e.source === "code");
        expect(codeEvidence?.file).toBe("apps/audit/query.ts");
        expect(codeEvidence?.lines).toBe("10-12");
        expect(codeEvidence?.snippet).toContain("select().from(rows)");
    });

    it("does NOT invent findings from `##` headers inside a fenced test plan", () => {
        // A real test plan uses its own `## Setup` / `## Steps` markdown headers; they are fenced in the
        // report. The parser must treat the section as ONE finding, never split the plan headers into
        // phantom "Setup"/"Steps" findings (the production "unknown" artifact bug).
        const withPlanHeaders: InvestigationReportInput = {
            ...INPUT,
            tests: [
                {
                    ...INPUT.tests[0]!,
                    plan: "# Test: Audit panel\n\n## Setup\nOn the page.\n\n## Steps\n1. click: row\n\n## Verification\n1. assert: visible",
                },
            ],
        };
        const parsed = parseReportMarkdown(buildReportMarkdown(withPlanHeaders));
        expect(parsed.findings).toHaveLength(1);
        expect(parsed.findings[0]?.slug).toBe("audit-panel");
        expect(parsed.findings.some((f) => ["Setup", "Steps", "Verification"].includes(f.slug))).toBe(false);
        // the plan (with its inner headers) is still recovered for the one real finding
        expect(parsed.findings[0]?.plan).toContain("## Setup");
    });

    it("recovers a classification-error finding", () => {
        const errorReport = parseReportMarkdown(
            buildReportMarkdown({
                client: "Homa",
                appSlug: "homa-next",
                prNumber: 7,
                tests: [
                    { slug: "t", plan: "p", runSuccess: true, stepCount: 1, verdicts: [{ model: "m", error: "boom" }] },
                ],
                suggested: [],
                deployed: { found: false, perTest: [] },
            }),
        );
        const errorFinding = errorReport.findings.find((f) => f.slug === "t");
        expect(errorFinding?.category).toBe("classification_error");
        expect(errorFinding?.error).toContain("boom");
    });
});
