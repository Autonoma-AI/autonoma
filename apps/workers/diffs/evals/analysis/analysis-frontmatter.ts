import { type DiffsAgentResult, MIN_DESCRIPTION_LENGTH } from "@autonoma/diffs";
import {
    type CheckFailure,
    baseFrontmatterSchema,
    checkCountBounds,
    checkIdentifierSet,
    countBoundsSchema,
    identifierSetCheckSchema,
} from "@autonoma/evals";
import { z } from "zod";

/**
 * Dedup-quality checks for the tests the diffs agent authors via `create_test`.
 *
 * Nothing culls a passing-but-redundant test once it is created, so this is the
 * primary automated guardrail against suite bloat.
 *
 * - `count` bounds how many tests `create_test` authored. A fully-covered diff
 *   should author none (`maxCount: 0`); a diff that introduces N genuinely new
 *   user-facing flows should author about N.
 * - `folders` grades which flow folders the authored tests land in (include /
 *   exclude / exact over `createdTests[].folderName`), so a case can assert that
 *   nothing new is authored into a folder whose flow is already covered.
 *
 * Whether each authored test is *genuinely* non-redundant, and whether its
 * coverage justification soundly names why existing tests do not cover it, is a
 * judge concern (the judge sees every authored test's plan + description +
 * justification). The deterministic side only bounds the shape and guarantees a
 * non-trivial description (see {@link checkDescriptions}) and a present coverage
 * justification (see {@link checkCoverageJustifications}).
 */
const createdTestsCheckSchema = z.object({
    count: countBoundsSchema.optional(),
    folders: identifierSetCheckSchema.optional(),
});

/**
 * Deterministic checks for an Analysis case, layered on the shared base.
 *
 * - `affected` grades the set of affected-test slugs (include / exclude / exact).
 * - `createdTests` grades the dedup discipline of the tests authored via
 *   `create_test` (see {@link createdTestsCheckSchema}).
 *
 * Anything subtler (was the reasoning sound? is an authored test genuinely
 * non-redundant?) belongs in the judge rubric, not here.
 */
export const analysisFrontmatterSchema = baseFrontmatterSchema.extend({
    affected: identifierSetCheckSchema.optional(),
    createdTests: createdTestsCheckSchema.optional(),
});

export type AnalysisFrontmatter = z.infer<typeof analysisFrontmatterSchema>;

/** Apply the Analysis deterministic checks to an agent result. Empty list means all checks passed. */
export function checkAnalysisResult(result: DiffsAgentResult, frontmatter: AnalysisFrontmatter): CheckFailure[] {
    return [
        ...checkAffected(result, frontmatter.affected),
        ...checkCreatedTests(result, frontmatter.createdTests),
        ...checkDescriptions(result),
        ...checkCoverageJustifications(result),
    ];
}

function checkAffected(result: DiffsAgentResult, affected: AnalysisFrontmatter["affected"]): CheckFailure[] {
    if (affected == null) return [];
    return checkIdentifierSet(
        "affected",
        result.affectedTests.map((t) => t.slug),
        affected,
    );
}

function checkCreatedTests(result: DiffsAgentResult, spec: AnalysisFrontmatter["createdTests"]): CheckFailure[] {
    if (spec == null) return [];

    const failures: CheckFailure[] = [];
    if (spec.count != null) {
        failures.push(...checkCountBounds("createdTests", result.createdTests.length, spec.count));
    }
    if (spec.folders != null) {
        failures.push(
            ...checkIdentifierSet(
                "createdTests.folders",
                result.createdTests.map((t) => t.folderName),
                spec.folders,
            ),
        );
    }
    return failures;
}

/**
 * Every authored test must carry a meaningful `description` - the durable,
 * falsifiable statement of what the test does, persisted as the test case's
 * immutable description. The `create_test` schema enforces a non-trivial string
 * (at least {@link MIN_DESCRIPTION_LENGTH} characters after trimming) upstream;
 * this backstops it at the grading boundary (blank or too-short is treated as
 * trivial) so the eval never silently scores a placeholder-description proposal
 * as a pass. The description's *quality* is graded by the judge. Always on - a
 * case need not opt in for the invariant to hold.
 */
function checkDescriptions(result: DiffsAgentResult): CheckFailure[] {
    const trivial = result.createdTests.filter((t) => t.description.trim().length < MIN_DESCRIPTION_LENGTH);
    if (trivial.length === 0) return [];

    return [
        {
            check: "createdTests.description",
            message: `authored test(s) [${trivial.map((t) => t.name).join(", ")}] carry a trivial description`,
        },
    ];
}

/**
 * Every authored test must carry a coverage justification - the creation-time
 * deduplication argument for why existing tests do not already cover it. The
 * `create_test` schema enforces a non-empty string upstream; this backstops it at
 * the grading boundary (whitespace-only is treated as absent) so the eval never
 * silently scores a justification-less proposal as a pass. Unlike the intent, the
 * justification is never persisted - it gates creation only. Its *soundness* is
 * graded by the judge. Always on - a case need not opt in for the invariant to hold.
 */
function checkCoverageJustifications(result: DiffsAgentResult): CheckFailure[] {
    const missing = result.createdTests.filter((t) => t.coverageJustification.trim() === "");
    if (missing.length === 0) return [];

    return [
        {
            check: "createdTests.coverageJustification",
            message: `authored test(s) [${missing.map((t) => t.name).join(", ")}] carry a blank coverage justification`,
        },
    ];
}
