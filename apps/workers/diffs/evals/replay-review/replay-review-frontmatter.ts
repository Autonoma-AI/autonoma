import { type CheckFailure, baseFrontmatterSchema, checkEnumEquality } from "@autonoma/evals";
import { type ReplayVerdict, replayVerdictKindSchema } from "@autonoma/types";
import type { z } from "zod";

/**
 * Deterministic checks for a replay review case.
 *
 * Only `verdict` is graded deterministically. Reasoning quality belongs in the
 * judge rubric.
 */
export const replayReviewFrontmatterSchema = baseFrontmatterSchema.extend({
    verdict: replayVerdictKindSchema.optional(),
});

export type ReplayReviewFrontmatter = z.infer<typeof replayReviewFrontmatterSchema>;

/** Apply the replay review deterministic checks to a verdict. Empty list means all checks passed. */
export function checkReplayReviewResult(verdict: ReplayVerdict, frontmatter: ReplayReviewFrontmatter): CheckFailure[] {
    const failures: CheckFailure[] = [];

    if (frontmatter.verdict != null) {
        failures.push(...checkEnumEquality("verdict", verdict.verdict, frontmatter.verdict));
    }

    return failures;
}
