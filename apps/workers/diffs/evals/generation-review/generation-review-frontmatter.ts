import { type CheckFailure, baseFrontmatterSchema, checkEnumEquality } from "@autonoma/evals";
import { type GenerationVerdict, generationVerdictKindSchema } from "@autonoma/types";
import type { z } from "zod";

/**
 * Deterministic checks for a generation review case.
 *
 * Only `verdict` is graded deterministically. Reasoning quality - correct
 * failure point, no hallucinated steps, sensible engine-vs-app attribution -
 * belongs in the judge rubric, not here.
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
