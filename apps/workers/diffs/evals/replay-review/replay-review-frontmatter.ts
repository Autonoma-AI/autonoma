import { type ReplayVerdict, replayVerdictKindSchema } from "@autonoma/types";
import type { z } from "zod";
import { type CheckFailure, baseFrontmatterSchema, checkEnumEquality } from "../framework/frontmatter";

/**
 * Deterministic checks for a replay review case.
 *
 * Only `verdict` is graded deterministically. The reviewer also emits
 * `severity` and `confidence`, but the production pipeline drops both
 * (resolution / healing decides on its own; see #783), so asserting on them
 * here would gate on dead fields. Reasoning quality belongs in the judge
 * rubric.
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
