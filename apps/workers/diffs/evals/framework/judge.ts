import { ObjectGenerator } from "@autonoma/ai";
import { summarizeSessionCost } from "@autonoma/diffs";
import type { InvestigationModelName } from "@autonoma/diffs/analysis";
import { type JudgeParams, type JudgeResult, judgeVerdictSchema } from "@autonoma/evals";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { createModelSession } from "../../src/services";

const SYSTEM_PROMPT = `You are a strict grader for an automated test-engineering agent.

You are given:
1. The agent's STRUCTURED OUTPUT (JSON).
2. A RUBRIC authored by a human reviewer.

The rubric is ADDITIVE to deterministic checks that have already passed: it grades qualities those
checks cannot express (e.g. whether reasoning is sound, whether the right rationale was given, whether
a suggestion is sensible). Grade ONLY what the rubric asks. Do not invent new requirements, and do not
re-derive ground truth from first principles - the rubric IS the ground truth.

You see only the structured output and the rubric. You do NOT see the codebase, diffs, or screenshots.
If a rubric point cannot be evaluated from the structured output alone, treat it as satisfied (it is
out of your scope), not failed.

Return passed=true only if the output satisfies every applicable rubric point. Otherwise passed=false,
and in your reasoning name the specific rubric point(s) that failed.`;

/**
 * Output-only LLM judge for diffs eval cases.
 *
 * Sees the step's structured output plus the authored rubric body and returns a
 * pass/fail verdict. It is deliberately step-agnostic (output is serialized to
 * JSON) so every per-step eval can reuse it. The judge opens its own
 * {@link createModelSession} so its cost is metered into a collector distinct
 * from the agent's.
 *
 * It grades serialized JSON against prose and never reads a screenshot, so it
 * runs on `impact` - the registry's one text-only, provider-agnostic key.
 */
export class DiffsJudge {
    private readonly logger: Logger;

    constructor(private readonly model: InvestigationModelName = "impact") {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    async judge({ output, rubric }: JudgeParams): Promise<JudgeResult> {
        this.logger.info("Judging agent output against rubric");

        const session = createModelSession();
        const model = session.getModel({ model: this.model, tag: "analysis-judge" });

        const generator = new ObjectGenerator({ model, systemPrompt: SYSTEM_PROMPT, schema: judgeVerdictSchema });
        const verdict = await generator.generate({ userPrompt: buildJudgePrompt(output, rubric) });

        const cost = summarizeSessionCost(session.costCollector);
        this.logger.info("Judge verdict", { extra: { passed: verdict.passed, cost } });

        return { ...verdict, cost };
    }
}

function buildJudgePrompt(output: unknown, rubric: string): string {
    return [
        "## Agent structured output",
        "```json",
        JSON.stringify(output, null, 2),
        "```",
        "",
        "## Rubric",
        rubric,
    ].join("\n");
}
