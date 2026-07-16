import { tool } from "ai";
import { z } from "zod";
import { runAgent } from "../../src/core/agent";
import { buildJudgeModel } from "../framework/judge-model";

const MAX_JUDGE_STEPS = 4;

/** A findings-rubric verdict: does the produced artifact contain the expected findings. */
export const plannerVerdictSchema = z.object({
    /** Whether the artifact satisfies the rubric. */
    passed: z.boolean(),
    /** Justification citing the specific rubric points that did or did not hold. */
    reasoning: z.string(),
});

export type PlannerVerdict = z.infer<typeof plannerVerdictSchema>;

const SYSTEM_PROMPT = `You grade a planner artifact against an authored findings rubric. The rubric is the
ground truth: it lists the findings the artifact must contain. Judge whether the artifact actually
contains them - be specific about which rubric points hold and which are missing or wrong. Do not
reward plausible-sounding content that isn't backed by the rubric's requirements. Call finish once.`;

export interface PlannerJudgeInput {
    step: string;
    /** The produced artifact text. */
    artifact: string;
    /** The authored findings rubric (the ground truth). */
    rubric: string;
    modelId?: string;
}

/** Grade one produced planner artifact against its rubric. Single-shot, no tools but `finish`. */
export async function judgePlannerArtifact(input: PlannerJudgeInput): Promise<PlannerVerdict | undefined> {
    let result: PlannerVerdict | undefined;

    const finishTool = tool({
        description: "Submit the findings-rubric verdict for this artifact.",
        inputSchema: plannerVerdictSchema,
        execute: async (verdict) => {
            result = verdict;
            return { accepted: true };
        },
    });

    const prompt = `Grade this "${input.step}" planner artifact against the rubric.

═══ RUBRIC (expected findings - the ground truth) ═══
${input.rubric}

═══ PRODUCED ARTIFACT ═══
${input.artifact}

Decide whether the artifact satisfies the rubric, then call finish with { passed, reasoning }.`;

    await runAgent(
        {
            id: `planner-judge:${input.step}`,
            systemPrompt: SYSTEM_PROMPT,
            model: buildJudgeModel(input.modelId),
            maxSteps: MAX_JUDGE_STEPS,
            temperature: 0,
            tools: { finish: finishTool },
        },
        prompt,
        () => result,
    );

    return result;
}
