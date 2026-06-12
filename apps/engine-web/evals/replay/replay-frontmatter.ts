import type { ReplayResult } from "@autonoma/engine";
import { type CheckFailure, baseFrontmatterSchema } from "@autonoma/evals";
import { z } from "zod";
import type { ReplayWebCommandSpec } from "../../src/replay/web-command-spec";

export const replayEvalFrontmatterSchema = baseFrontmatterSchema.extend({
    stepCount: z.number().int().nonnegative().optional(),
});

export type ReplayEvalFrontmatter = z.infer<typeof replayEvalFrontmatterSchema>;

/** Apply the replay eval deterministic checks. Empty list means all checks passed. */
export function checkReplayResult(
    result: ReplayResult<ReplayWebCommandSpec>,
    frontmatter: ReplayEvalFrontmatter,
): CheckFailure[] {
    const failures: CheckFailure[] = [];

    if (!result.success) {
        const failedIndex = result.state.executionResults.findIndex((r) => r.status === "failed");
        const stepRef = failedIndex >= 0 ? `at step ${failedIndex}` : "before any step executed";
        const reasonSuffix = result.reasoning != null ? `: ${result.reasoning}` : "";
        failures.push({
            check: "success",
            message: `expected replay to succeed but it failed ${stepRef}${reasonSuffix}`,
        });
    }

    if (frontmatter.stepCount != null && result.state.executedSteps.length !== frontmatter.stepCount) {
        failures.push({
            check: "stepCount",
            message: `expected ${frontmatter.stepCount} steps but executed ${result.state.executedSteps.length}`,
        });
    }

    return failures;
}
