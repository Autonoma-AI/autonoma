import { Category, PlanFidelity, type RunVerdict } from "@autonoma/diffs/analysis";
import { type CheckFailure, baseFrontmatterSchema, checkEnumEquality } from "@autonoma/evals";
import { z } from "zod";

/** How many times a single case is classified per suite run. One is enough to gate; more measures stability. */
const DEFAULT_RUNS = 1;

/**
 * The shortest a revised plan can be and still carry instruction. A `plan_mismatch` carries the COMPLETE
 * rewritten plan, so anything under this is a placeholder ("n/a", "TODO", "same") - present but empty of steps,
 * which the self-heal loop would re-run to no effect. Set well below any real multi-step plan so it only ever
 * trips on a non-answer, never a terse-but-genuine rewrite.
 */
const MIN_SUGGESTED_TEST_UPDATE_LENGTH = 20;

/**
 * Deterministic checks for a Classifier case, layered on the shared base.
 *
 * Only three things are graded here, and the omissions are deliberate:
 *
 * - `confidence` is NOT graded. It is the field most likely to move between two runs of an unchanged
 *   classifier, so asserting it would make a case flaky without saying anything a reader could act on.
 * - `evidence` is NOT graded beyond the schema's own `min(1)`. Whether the cited evidence actually supports
 *   the verdict is exactly the kind of judgement the rubric exists for.
 * - `keyStepIndex` is NOT graded. Which frame best shows a finding is a judgement call, and an index naming
 *   no step is already handled downstream by showing no screenshot at all.
 */
export const classifierFrontmatterSchema = baseFrontmatterSchema.extend({
    /**
     * The verdict this case asserts. Left BLANK by capture on purpose: pre-filling it from production would
     * make rubber-stamping a wrong verdict the path of least resistance. A case with no `category` runs its
     * rubric only.
     */
    category: Category.optional(),
    /**
     * What production said the day this case was frozen, never edited afterwards. Provenance, not an
     * assertion - when `category` is later re-baselined (an `engine_artifact` that should now read `passed`
     * because the engine grew the capability), this still shows where the case started.
     */
    capturedCategory: Category.optional(),
    /** How closely the run followed the written steps. Orthogonal to the verdict, so graded separately. */
    planFidelity: PlanFidelity.optional(),
    /**
     * Whether a `plan_mismatch` must carry a rewritten plan. Defaults to requiring one, because a
     * `plan_mismatch` that proposes nothing leaves the test exactly as broken as it found it. Set false for a
     * case whose right answer is the empty rewrite - the loop reads that as "keep this test without re-running
     * it", a real answer that a blanket requirement would train the classifier out of giving.
     */
    expectRewrite: z.boolean().default(true),
    /**
     * How many times to classify this case. Above one, EVERY run must satisfy the checks, so this measures
     * whether a verdict is stable rather than whether it is reachable.
     */
    runs: z.number().int().positive().default(DEFAULT_RUNS),
});

export type ClassifierFrontmatter = z.infer<typeof classifierFrontmatterSchema>;

/** Apply the Classifier deterministic checks to one verdict. An empty list means the checks passed. */
export function checkClassifierVerdict(verdict: RunVerdict, frontmatter: ClassifierFrontmatter): CheckFailure[] {
    return [
        ...checkCategory(verdict, frontmatter),
        ...checkPlanFidelity(verdict, frontmatter),
        ...checkSuggestedTestUpdate(verdict, frontmatter),
    ];
}

function checkCategory(verdict: RunVerdict, frontmatter: ClassifierFrontmatter): CheckFailure[] {
    if (frontmatter.category == null) return [];
    return checkEnumEquality("category", verdict.category, frontmatter.category);
}

function checkPlanFidelity(verdict: RunVerdict, frontmatter: ClassifierFrontmatter): CheckFailure[] {
    if (frontmatter.planFidelity == null) return [];
    return checkEnumEquality("planFidelity", verdict.planFidelity, frontmatter.planFidelity);
}

/**
 * A `plan_mismatch` verdict is the entry point to the self-heal loop, and `suggestedTestUpdate` is the plan
 * that loop re-runs - so a blank OR placeholder-length one on a case that expects a rewrite means the classifier
 * diagnosed a fixable test and then fixed nothing. Only applies to the arm that carries the field; every other
 * category is silent.
 */
function checkSuggestedTestUpdate(verdict: RunVerdict, frontmatter: ClassifierFrontmatter): CheckFailure[] {
    if (verdict.category !== "plan_mismatch" || !frontmatter.expectRewrite) return [];

    const revisedPlan = verdict.suggestedTestUpdate.trim();
    if (revisedPlan.length >= MIN_SUGGESTED_TEST_UPDATE_LENGTH) return [];

    return [
        {
            check: "suggestedTestUpdate",
            message: `plan_mismatch carried a ${revisedPlan.length}-char revised plan (min ${MIN_SUGGESTED_TEST_UPDATE_LENGTH}); set expectRewrite: false if the empty rewrite is the right answer`,
        },
    ];
}
