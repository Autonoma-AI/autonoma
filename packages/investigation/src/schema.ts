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
 * A distinct app defect the run made VISIBLE on screen but that is SEPARATE from this test's own assertion - the
 * kind of thing a human spots at a glance and the goal-directed run walks past (overlapping/clipped text, a raw id
 * or untranslated key leaking into the UI, a broken image, an empty region where data is expected). Each becomes
 * its OWN finding so it can be tracked and reconciled independently of the test that happened to surface it - the
 * classifier's verdict is one-per-test, but a single run can reveal several unrelated defects.
 */
export const SecondaryObservation = z.object({
    category: Category,
    confidence: Confidence,
    headline: z.string(),
    detail: z.string(),
});
export type SecondaryObservation = z.infer<typeof SecondaryObservation>;

export const RunVerdict = z.object({
    category: Category,
    /** True iff `category === "client_bug"`. The only strict true positive. */
    isClientBug: z.boolean(),
    /** Did the test actually execute against the running app (vs blocked before it could run)? */
    ran: z.boolean(),
    confidence: Confidence,
    planFidelity: PlanFidelity.optional(),
    /** The COMPLETE revised test plan when the run revealed the plan should change; absent otherwise. */
    suggestedTestUpdate: z.string().optional(),
    /** App problems visible in the video independent of this test's pass/fail (broken images, empty content,
     * layout/overlap, things not loading). Absent when the app looked healthy. */
    observedAppIssues: z.string().optional(),
    /** Distinct visible defects, SEPARATE from this test's assertion, each promoted to its own finding. The
     * structured, trackable breakdown of what `observedAppIssues` summarizes. Absent/empty when nothing else broke. */
    secondaryObservations: z.array(SecondaryObservation).optional(),
    headline: z.string().describe("ONE sentence: the takeaway, with the key `code`/file if relevant."),
    /** The agent's explicit false-positive self-check (could this be an intended change / not a real bug?). */
    falsePositiveRisk: z.string(),
    whatHappened: z.string(),
    rootCause: z.string(),
    remediation: z.string(),
    evidence: z.array(Evidence).min(1),
    /**
     * The 1-indexed trace step whose captured screenshot MOST clearly shows this finding to a human reviewer -
     * the frame to feature in the report. Deliberately the agent's call, not the failed step: an assertion can
     * be wrong, and the real defect is often most visible a step earlier/later. Absent to fall back to the final
     * screenshot.
     */
    keyStepIndex: z.number().int().positive().optional(),
});
export type RunVerdict = z.infer<typeof RunVerdict>;
