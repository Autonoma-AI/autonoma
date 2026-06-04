import { type GenerationVerdict, generationVerdictKindSchema } from "@autonoma/types";
import type { z } from "zod";
import { type CheckFailure, baseFrontmatterSchema, checkEnumEquality } from "../framework/frontmatter";

/**
 * Deterministic checks for a generation review case.
 *
 * Only `verdict` is graded deterministically. The reviewer also emits
 * `severity` and `confidence`, but the production pipeline drops both
 * (resolution / healing decides on its own; see #783), so asserting on them
 * here would gate on dead fields. Reasoning quality - correct failure point,
 * no hallucinated steps, sensible engine-vs-app attribution - belongs in the
 * judge rubric, not here.
 */
export const generationReviewFrontmatterSchema = baseFrontmatterSchema.extend({
    verdict: generationVerdictKindSchema.optional(),
});

export type GenerationReviewFrontmatter = z.infer<typeof generationReviewFrontmatterSchema>;

/** Apply the generation review deterministic checks to a verdict. Empty list means all checks passed. */
export function checkGenerationReviewResult(
    verdict: GenerationVerdict,
    frontmatter: GenerationReviewFrontmatter,
): CheckFailure[] {
    const failures: CheckFailure[] = [];

    if (frontmatter.verdict != null) {
        failures.push(...checkEnumEquality("verdict", verdict.verdict, frontmatter.verdict));
    }

    return failures;
}
