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
    "plan_mismatch",
    "invalid_test",
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

/** App-health verdicts (`passed`, `client_bug`) describe app behavior with expected-vs-actual. */
const behaviorVerdictBase = verdictBase.extend({
    /** What the app SHOULD have done. Always stated; when the correct behavior genuinely cannot be determined
     * the agent says so explicitly here rather than leaving it blank. */
    expectedBehavior: z.string(),
    /** What the app actually did in the run - including any observed errors and the proven mechanism. */
    actualBehavior: z.string(),
});

/** The app-health bug verdict (`client_bug`) adds the explicit false-positive self-check. */
const problemVerdictBase = behaviorVerdictBase.extend({
    /** The agent's explicit false-positive self-check (could this be an intended change / setup gap, not a defect?). */
    falsePositiveRisk: z.string(),
});

/** Coverage-plane verdicts describe a NON-app cause in free-form prose instead of app expected/actual. */
const coverageVerdictBase = verdictBase.extend({
    /** Free-form account of what happened - the coverage plane's analog of expected/actual. */
    whatHappened: z.string(),
});

/** A setup/infra failure (`environment_failure` / `scenario_issue`) adds the false-positive self-check
 * ("am I sure this is env/data, not a real bug?") on top of the coverage narrative. */
const setupFailureBase = coverageVerdictBase.extend({
    falsePositiveRisk: z.string(),
});

/**
 * `plan_mismatch`: the app rendered correctly but the test's plan does not match it. Carries the complete revised plan
 * the self-heal loop re-runs, plus the self-heal post-mortem. No app expected/actual - the app is fine.
 *
 * Both fields DEFAULT to empty rather than being strictly required. An empty `suggestedTestUpdate` is a real answer -
 * "no viable rewrite exists", which the loop reads as "keep this test without re-running it" - and neither field is
 * worth failing the parse over: a rejected verdict is contained as an `engine_artifact`, which would turn this
 * pipeline's own flagship case (a kept `plan_mismatch`) into a harness fault and lose the diagnosis entirely.
 */
const planMismatchBase = verdictBase.extend({
    /** The COMPLETE revised test plan the self-heal loop re-runs; empty when no viable rewrite exists. */
    suggestedTestUpdate: z.string().default(""),
    /** The self-heal post-mortem: what the test asserted that was wrong, the rewrite attempted, and - on a re-run -
     * why the prior rewrite still failed. */
    planMismatchNote: z.string().default(""),
});

/**
 * `invalid_test`: the test is IRREPARABLY broken and must be REMOVED - the high-confidence, affirmative counterpart
 * to `plan_mismatch` (salvageable, kept). This verdict destroys a test, so it carries a mandatory false-positive
 * self-check and a dedicated justification note, and its evidence proving the impossibility is required (min 1,
 * enforced on the arm below). No app expected/actual - the app is fine.
 */
const invalidTestBase = verdictBase.extend({
    /** The justification, prescribed: which failure mode (nonexistent feature / structurally unexecutable steps /
     * wrong premise contradicting the app / otherwise unrecoverable) and the PROOF of impossibility. */
    invalidTestNote: z.string(),
    /** The mandatory "could this actually be salvageable?" self-check - the guardrail against over-removal. */
    falsePositiveRisk: z.string(),
});

/**
 * The outcome of classifying one run, as a per-category discriminated union: each arm carries exactly the fields
 * that category needs. The app-health verdicts (`passed`, `client_bug`) describe app behavior (expected/actual); the
 * coverage faults (`engine_artifact`, `environment_failure`, `scenario_issue`) carry a free-form `whatHappened`;
 * `plan_mismatch` carries the revised plan + its post-mortem; `invalid_test` carries its impossibility justification +
 * a mandatory false-positive check + required evidence. The wire schema the model fills is a flat object (see
 * `VerdictForModel`) piped into this union, so the model sees a plain object while consumers get per-category
 * narrowing and no category is forced to emit fields that don't apply to it.
 */
export const RunVerdict = z.discriminatedUnion("category", [
    behaviorVerdictBase.extend({ category: z.literal("passed") }),
    problemVerdictBase.extend({ category: z.literal("client_bug"), evidence: z.array(Evidence).min(1) }),
    setupFailureBase.extend({ category: z.literal("environment_failure") }),
    setupFailureBase.extend({ category: z.literal("scenario_issue") }),
    coverageVerdictBase.extend({ category: z.literal("engine_artifact") }),
    planMismatchBase.extend({ category: z.literal("plan_mismatch") }),
    invalidTestBase.extend({ category: z.literal("invalid_test"), evidence: z.array(Evidence).min(1) }),
]);
export type RunVerdict = z.infer<typeof RunVerdict>;
