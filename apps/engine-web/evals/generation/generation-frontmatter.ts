import type { ExecutionResult } from "@autonoma/engine";
import { type CheckFailure, baseFrontmatterSchema, checkCountBounds, checkEnumEquality } from "@autonoma/evals";
import { z } from "zod";
import type { WebCommandSpec } from "../../src/execution-agent/web-agent";

const LOOP_SIGNALS = ["loop", "stuck", "no progress", "repeating", "going in circles", "cycling"];

const stepsChecksSchema = z.object({
    minCount: z.number().int().nonnegative().optional(),
    maxCount: z.number().int().nonnegative().optional(),
    includesInteractions: z.array(z.string()).optional(),
    noLoop: z.boolean().optional(),
});

export const generationEvalFrontmatterSchema = baseFrontmatterSchema.extend({
    finishReason: z.enum(["success", "max_steps", "error"]).optional(),
    steps: stepsChecksSchema.optional(),
});

export type GenerationEvalFrontmatter = z.infer<typeof generationEvalFrontmatterSchema>;

/** Apply the generation eval deterministic checks. Empty list means all checks passed. */
export function checkGenerationResult(
    result: ExecutionResult<WebCommandSpec>,
    frontmatter: GenerationEvalFrontmatter,
): CheckFailure[] {
    const failures: CheckFailure[] = [];

    if (frontmatter.finishReason != null) {
        failures.push(...checkEnumEquality("finishReason", result.finishReason, frontmatter.finishReason));
    }

    if (frontmatter.steps != null) {
        const { minCount, maxCount, includesInteractions, noLoop } = frontmatter.steps;
        const successSteps = result.generatedSteps.filter((s) => s.status === "success");

        if (minCount != null || maxCount != null) {
            failures.push(...checkCountBounds("steps", successSteps.length, { minCount, maxCount }));
        }

        if (includesInteractions != null && includesInteractions.length > 0) {
            const actualInteractions: Set<string> = new Set(
                successSteps.map((s) => s.executionOutput.stepData.interaction),
            );
            for (const required of includesInteractions) {
                if (!actualInteractions.has(required)) {
                    failures.push({
                        check: "steps.includesInteractions",
                        message: `expected an interaction of type "${required}" but none was found`,
                    });
                }
            }
        }

        if (noLoop === true) {
            failures.push(...checkNoLoop(result));
        }
    }

    return failures;
}

function checkNoLoop(result: ExecutionResult<WebCommandSpec>): CheckFailure[] {
    const reasoning = result.reasoning?.toLowerCase() ?? "";
    const matched = LOOP_SIGNALS.find((signal) => reasoning.includes(signal));
    if (matched == null) return [];
    return [
        {
            check: "steps.noLoop",
            message: `finish reasoning contains loop signal "${matched}": ${result.reasoning?.slice(0, 200) ?? ""}`,
        },
    ];
}
