import { logger as rootLogger } from "@autonoma/logger";
import { generateText } from "ai";
import type { LanguageModel } from "ai";
import { withRetry } from "./retry";
import type { CoverageSummary, TwoPlaneSummary } from "./verdict-planes";

// A single short text pass over already-decided counts - no tool loop, no code reads - so the call is cheap. It
// retries at most twice, well inside the Reconciler activity's timeout.
const NARRATION_TIMEOUT_MS = 2 * 60_000;
const MODEL_CALL_TRIES = 2;

export interface NarrateAnalysisDeps {
    /** The FINALIZED two-plane verdict. Fixed input the narration may describe but never re-judge. */
    summary: TwoPlaneSummary;
    /** How many distinct findings the run produced after dedup - context for the prose. */
    findingCount: number;
    model: LanguageModel;
}

/**
 * Narrate an already-finalized two-plane verdict as prose. This is CONSTRAINED narration: the verdict + both
 * planes are passed in as fixed input and the model returns a summary string only - it cannot re-judge,
 * re-categorize, or alter the verdict, and its output is never fed back into verdict logic. Never throws: a
 * model failure (or empty output) is contained and returns `undefined`, so a narration problem can never sink
 * the Reconciler; the run simply persists no narration.
 */
export async function narrateAnalysis(deps: NarrateAnalysisDeps): Promise<string | undefined> {
    const { summary, findingCount, model } = deps;
    const logger = rootLogger.child({ name: "narrateAnalysis", extra: { verdict: summary.verdict, findingCount } });

    logger.info("Narrating the finalized verdict");
    try {
        const result = await withRetry(
            () =>
                generateText({
                    model,
                    system: NARRATION_SYSTEM_PROMPT,
                    prompt: buildNarrationPrompt(summary, findingCount),
                    abortSignal: AbortSignal.timeout(NARRATION_TIMEOUT_MS),
                }),
            { label: "analysis-reconcile-narration", tries: MODEL_CALL_TRIES },
        );
        const narration = result.text.trim();
        if (narration === "") {
            logger.warn("Narration model returned empty text; omitting the narration");
            return undefined;
        }
        logger.info("Narration produced", { extra: { length: narration.length } });
        return narration;
    } catch (error) {
        logger.warn("Narration failed; omitting the narration", { err: error });
        return undefined;
    }
}

const NARRATION_SYSTEM_PROMPT = `You write a short, plain-English summary of ONE run of an automated end-to-end
test suite against a pull request. The run has ALREADY been judged: you are given the final verdict and the exact
counts behind it. Your ONLY job is to describe that result in prose.

Two planes were decided for you:
- App-health (the headline): "client_bug" means the app misbehaved on this PR - the only result that counts
  against the PR. "passed" means it did not.
- Coverage-confidence: non-bug outcomes that never count against the PR - engine artifacts (harness flakes,
  crashes, timeouts), environment failures (the preview was unavailable), scenario issues (mis-seeded test
  data), and deletes (a healthy app whose test could not be stabilized, so it was dropped). A delete is split by
  whether the test was newly proposed this run (coverage we could not establish) or pre-existing (an obsolete
  test removed).

Rules:
- Do NOT re-evaluate, re-classify, second-guess, or contradict the verdict. It is fixed.
- Do NOT invent findings, causes, or counts beyond the numbers you are given.
- Keep it to 2-4 sentences. Lead with the app-health headline, then summarize the coverage plane if anything is
  there. Be factual and terse. Return prose only - no headings, no lists, no markdown.`;

/** The user prompt: the fixed verdict + both planes' counts - everything the narration describes. */
function buildNarrationPrompt(summary: TwoPlaneSummary, findingCount: number): string {
    const { verdict, coverage } = summary;
    const lines = [
        `Final app-health verdict: ${verdict}.`,
        `Distinct findings after deduplication: ${findingCount}.`,
        `Coverage-plane findings: ${coverage.total}.`,
        coverageByCategoryLine(coverage),
        `Proposed tests that could not be established: ${coverage.unestablishedProposed}.`,
        `Pre-existing tests removed as obsolete: ${coverage.obsoleteRemoved}.`,
        "",
        "Write the summary.",
    ];
    return lines.join("\n");
}

function coverageByCategoryLine(coverage: CoverageSummary): string {
    if (coverage.byCategory.length === 0) return "Coverage-plane breakdown: none.";
    const parts = coverage.byCategory.map((entry) => `${entry.category}=${entry.count}`).join(", ");
    return `Coverage-plane breakdown: ${parts}.`;
}
