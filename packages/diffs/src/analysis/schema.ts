import { z } from "zod";

/**
 * The outcome of actually RUNNING a selected test against the PR's live app.
 * `client_bug` is the only strict true positive and requires the app to have
 * actually misbehaved during the run (not a flake, env problem, or stale test).
 */
export const Category = z.enum([
    "passed",
    "client_bug",
    "engine_artifact",
    "environment_failure",
    "scenario_issue",
    "outdated_test",
    "bad_test",
]);
export type Category = z.infer<typeof Category>;

export const EvidenceSource = z.enum(["run", "screenshot", "video", "code", "diff"]);
export type EvidenceSource = z.infer<typeof EvidenceSource>;

/** How closely the actual run followed the written test steps - orthogonal to verdict confidence. */
export const PlanFidelity = z.enum(["exact", "partial", "diverged"]);
export type PlanFidelity = z.infer<typeof PlanFidelity>;

export const Confidence = z.enum(["low", "medium", "high"]);
export type Confidence = z.infer<typeof Confidence>;

export const Evidence = z.object({
    source: EvidenceSource,
    detail: z.string().describe("What you observed and what it showed."),
    file: z.string().optional().describe("repo-relative path (when source=code/diff)."),
    lines: z.string().optional().describe("line range, e.g. '34-41'."),
    snippet: z.string().optional().describe("the exact code excerpt that matters."),
});
export type Evidence = z.infer<typeof Evidence>;

/**
 * The fields every verdict arm carries, regardless of category. `expectedBehavior`/`actualBehavior` and the
 * problem-only `falsePositiveRisk` are added per arm below - a `passed` finding never carries a false-positive
 * check, an `engine_artifact` never carries expected/actual, so the shape can't force filler onto a category it
 * doesn't apply to.
 */
const verdictBase = z.object({
    /** True iff `category === "client_bug"`. The only strict true positive. */
    isClientBug: z.boolean(),
    /** Did the test actually execute against the running app (vs blocked before it could run)? */
    ran: z.boolean(),
    confidence: Confidence,
    planFidelity: PlanFidelity.optional(),
    /** App problems visible in the video independent of this test's pass/fail (broken images, empty content,
     * layout/overlap, things not loading). Absent when the app looked healthy. */
    observedAppIssues: z.string().optional(),
    headline: z.string().describe("ONE sentence: the takeaway, with the key `code`/file if relevant."),
    evidence: z.array(Evidence),
    /**
     * The 1-indexed trace step whose captured screenshot MOST clearly shows this finding to a human reviewer -
     * the frame to feature in the report. Deliberately the agent's call, not the failed step: an assertion can
     * be wrong, and the real defect is often most visible a step earlier/later. Absent to fall back to the final
     * screenshot.
     */
    keyStepIndex: z.number().int().positive().optional(),
});

/** Verdicts that describe app behavior carry expected-vs-actual, replacing the old free-form `whatHappened`. */
const behaviorVerdictBase = verdictBase.extend({
    /** What the app SHOULD have done. Always stated; when the correct behavior genuinely cannot be determined
     * the agent says so explicitly here rather than leaving it blank. */
    expectedBehavior: z.string(),
    /** What the app actually did in the run - including any observed errors and the proven mechanism. */
    actualBehavior: z.string(),
});

/** Problem verdicts (a bug or a setup failure) add the explicit false-positive self-check. */
const problemVerdictBase = behaviorVerdictBase.extend({
    /** The agent's explicit false-positive self-check (could this be an intended change / setup gap, not a defect?). */
    falsePositiveRisk: z.string(),
});

/** A transient "the test itself is wrong on a healthy app" verdict; carries the complete revised plan to re-run. */
const testIsWrongVerdictBase = verdictBase.extend({
    /** The COMPLETE revised test plan the self-heal loop re-runs. */
    suggestedTestUpdate: z.string(),
    expectedBehavior: z.string().optional(),
    actualBehavior: z.string().optional(),
});

/**
 * The outcome of classifying one run, as a per-category discriminated union: each arm carries exactly the fields
 * that category needs. `passed` and the problem verdicts describe behavior (expected/actual); `engine_artifact`
 * carries only the base account; `outdated_test`/`bad_test` carry the revised plan. The wire schema the model
 * fills is a flat object (see `VerdictForModel`) piped into this union, so the model sees a plain object while
 * consumers get per-category narrowing and no category is forced to emit fields that don't apply to it.
 */
export const RunVerdict = z.discriminatedUnion("category", [
    behaviorVerdictBase.extend({ category: z.literal("passed") }),
    problemVerdictBase.extend({ category: z.literal("client_bug"), evidence: z.array(Evidence).min(1) }),
    problemVerdictBase.extend({ category: z.literal("environment_failure") }),
    problemVerdictBase.extend({ category: z.literal("scenario_issue") }),
    verdictBase.extend({ category: z.literal("engine_artifact") }),
    testIsWrongVerdictBase.extend({ category: z.literal("outdated_test") }),
    testIsWrongVerdictBase.extend({ category: z.literal("bad_test") }),
]);
export type RunVerdict = z.infer<typeof RunVerdict>;
