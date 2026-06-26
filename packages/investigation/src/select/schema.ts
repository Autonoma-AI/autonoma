import { z } from "zod";

/** An existing test the diff could affect, with the reason it was selected. */
export const AffectedTestSelection = z.object({
    slug: z.string(),
    reason: z.string(),
});
export type AffectedTestSelection = z.infer<typeof AffectedTestSelection>;

/** A NEW test the agent proposes for behavior the diff introduced that no existing test covers. */
export const SuggestedTest = z.object({
    name: z.string(),
    /** A full E2E plan (Setup / Steps / Verification) following the platform test guardrails. */
    instruction: z.string(),
    reasoning: z.string(),
});
export type SuggestedTest = z.infer<typeof SuggestedTest>;

/** An EXISTING test the agent recommends quarantining because the PR REMOVED the functionality it covers. */
export const QuarantineRecommendation = z.object({
    slug: z.string(),
    reason: z.string(),
});
export type QuarantineRecommendation = z.infer<typeof QuarantineRecommendation>;

/** The selector's output: affected existing tests + new tests to add + tests to quarantine (deleted features). */
export const SelectionResult = z.object({
    affected: z.array(AffectedTestSelection),
    suggested: z.array(SuggestedTest),
    quarantine: z.array(QuarantineRecommendation),
});
export type SelectionResult = z.infer<typeof SelectionResult>;
