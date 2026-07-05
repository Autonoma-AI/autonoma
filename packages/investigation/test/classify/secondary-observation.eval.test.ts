import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Output, generateText } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
    CLASSIFIER_SYSTEM_PROMPT,
    VerdictForModel,
    buildVerdictPrompt,
    openModelSession,
    toRunVerdict,
} from "../../src";

/**
 * Evaluates the classifier's SECONDARY-DEFECT capture (and the never-loads escalation guard) on the decision leg.
 *
 * The classifier's verdict is one-per-test, so a run that surfaces a real bug UNRELATED to the test's own assertion
 * used to lose it - the bug was mentioned in an observedAppIssues footnote and the verdict was pinned on the test.
 * This eval, built from real prod runs (anonymized), feeds the decision leg investigation notes that describe BOTH
 * the test's assertion outcome AND a distinct visible defect the probes flagged, then checks the verdict:
 *   - CAPTURE: the distinct defect becomes its own `secondaryObservation` (not dropped),
 *   - ESCALATE: when the PRIMARY content never rendered, the category is an app/data/env failure, never
 *     outdated_test/bad_test (those assert the app worked),
 *   - NO-HALLUCINATION: a clean run (healthy app, merely stale/garbled assertion) yields NO secondaryObservations.
 *
 * It exercises the DECISION reasoning given what was observed - not the vision probes that do the observing - so it
 * measures exactly the prompt wiring this change adds. Hits the live OpenAI API, RUN_EVALS=1 only:
 *   RUN_EVALS=1 pnpm --filter @autonoma/investigation exec vitest run test/classify/secondary-observation.eval.test.ts
 */
const RUN = process.env.RUN_EVALS === "1" && process.env.OPENAI_API_KEY != null && process.env.OPENAI_API_KEY !== "";

// Calibrated on a live gpt-5.5 run (capture 100%, escalation 100%, false-capture 0%); thresholds sit one
// model-flake below the observed values so they guard regressions in the wiring, not benign model noise.
const CAPTURE_RECALL_MIN = 0.8;
const ESCALATION_RATE_MIN = 1;
const MAX_FALSE_CAPTURE_RATE = 0.0;
const DECISION_TIMEOUT_MS = 90_000;

const CaseSchema = z.object({
    id: z.string(),
    kind: z.enum(["escalate", "capture", "escalate-and-capture", "clean"]),
    plan: z.string(),
    priorRuns: z.string(),
    notes: z.string(),
    expectCategory: z.array(z.string()).optional(),
    expectCategoryNotIn: z.array(z.string()).optional(),
    expectSecondaryAbout: z.array(z.string()).optional(),
    expectNoSecondary: z.boolean().optional(),
});
type EvalCase = z.infer<typeof CaseSchema>;

function loadCases(): EvalCase[] {
    const path = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "secondary-observation-cases.json");
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    return z.array(CaseSchema).parse(raw);
}

function matchesKeyword(text: string, keywords: string[]): boolean {
    const haystack = text.toLowerCase();
    return keywords.some((keyword) => haystack.includes(keyword.toLowerCase()));
}

async function classify(model: Parameters<typeof generateText>[0]["model"], testCase: EvalCase) {
    const notes = `prior_runs: ${testCase.priorRuns}\n\n${testCase.notes}`;
    // Mirrors the decision leg in classify-run.ts exactly: same system prompt, same structured output schema,
    // same buildVerdictPrompt wiring - only the investigation notes are the fixture instead of a live tool loop.
    const generation = await generateText({
        model,
        system: CLASSIFIER_SYSTEM_PROMPT,
        output: Output.object({ schema: VerdictForModel }),
        prompt: buildVerdictPrompt(testCase.plan, notes),
        abortSignal: AbortSignal.timeout(DECISION_TIMEOUT_MS),
    });
    return toRunVerdict(generation.output);
}

describe.skipIf(!RUN)("eval: classifier secondary-defect capture + never-loads escalation", () => {
    it(
        "captures distinct off-flow defects, escalates never-loaded content, and stays quiet on clean runs",
        async () => {
            const cases = loadCases();
            const model = openModelSession({ openaiApiKey: process.env.OPENAI_API_KEY ?? "" }).getModel({
                model: "classifier",
                tag: "eval-secondary-observation",
            });

            const results = await Promise.all(
                cases.map(async (testCase) => {
                    const verdict = await classify(model, testCase);
                    const observations = verdict.secondaryObservations ?? [];
                    const needsCapture = testCase.expectSecondaryAbout != null;
                    const captured = observations.some((o) =>
                        matchesKeyword(`${o.headline} ${o.detail}`, testCase.expectSecondaryAbout ?? []),
                    );
                    const needsEscalation = testCase.expectCategoryNotIn != null;
                    const escalated = !(testCase.expectCategoryNotIn ?? []).includes(verdict.category);
                    return { testCase, verdict, observations, needsCapture, captured, needsEscalation, escalated };
                }),
            );

            const captureCases = results.filter((r) => r.needsCapture);
            const escalateCases = results.filter((r) => r.needsEscalation);
            const cleanCases = results.filter((r) => r.testCase.expectNoSecondary === true);

            const captureRecall =
                captureCases.length === 0 ? 1 : captureCases.filter((r) => r.captured).length / captureCases.length;
            const escalationRate =
                escalateCases.length === 0 ? 1 : escalateCases.filter((r) => r.escalated).length / escalateCases.length;
            const falseCaptures = cleanCases.filter((r) => r.observations.length > 0);
            const falseCaptureRate = cleanCases.length === 0 ? 0 : falseCaptures.length / cleanCases.length;

            // eslint-disable-next-line no-console
            console.log(
                `\n[eval] classifier secondary-defect capture over ${cases.length} cases:\n` +
                    results
                        .map(
                            (r) =>
                                `  ${r.testCase.id.padEnd(48)} cat=${r.verdict.category.padEnd(20)} ` +
                                `obs=${r.observations.length}` +
                                `${r.needsCapture ? `  capture=${r.captured ? "OK" : "MISS"}` : ""}` +
                                `${r.needsEscalation ? `  escalate=${r.escalated ? "OK" : "MISS"}` : ""}` +
                                `${r.testCase.expectNoSecondary === true && r.observations.length > 0 ? "  FALSE-CAPTURE" : ""}`,
                        )
                        .join("\n") +
                    `\n\n  captureRecall=${(captureRecall * 100).toFixed(0)}%  escalationRate=${(escalationRate * 100).toFixed(0)}%  ` +
                    `falseCaptureRate=${(falseCaptureRate * 100).toFixed(0)}%\n`,
            );

            const out = process.env.CLASSIFY_EVAL_OUT;
            if (out != null && out !== "") {
                const { writeFileSync } = await import("node:fs");
                writeFileSync(
                    out,
                    JSON.stringify(
                        {
                            captureRecall,
                            escalationRate,
                            falseCaptureRate,
                            rows: results.map((r) => ({
                                id: r.testCase.id,
                                category: r.verdict.category,
                                observations: r.observations,
                                captured: r.needsCapture ? r.captured : undefined,
                                escalated: r.needsEscalation ? r.escalated : undefined,
                            })),
                        },
                        null,
                        2,
                    ),
                );
            }

            expect(captureRecall).toBeGreaterThanOrEqual(CAPTURE_RECALL_MIN);
            expect(escalationRate).toBeGreaterThanOrEqual(ESCALATION_RATE_MIN);
            expect(falseCaptureRate).toBeLessThanOrEqual(MAX_FALSE_CAPTURE_RATE);
        },
        DECISION_TIMEOUT_MS * cases_upper_bound(),
    );
});

/** Vitest needs a static-ish timeout; bound it by the max fixture count we ship. */
function cases_upper_bound(): number {
    return 20;
}
