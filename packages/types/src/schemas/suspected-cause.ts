import { z } from "zod";

/**
 * A single concrete code location implicated in a suspected application bug.
 *
 * `repo` is forward-compat for multi-repo grounding (Epic #1058): today a
 * snapshot only ever checks out the primary repo, so an omitted `repo` means
 * "the primary repo". Once multi-repo grounding lands, callers populate `repo`
 * and the rest of the shape is unchanged - the field is purely additive.
 */
export const codeReferenceSchema = z.object({
    repo: z.string().optional().describe("Repository the file lives in. Defaults to the primary repo when omitted."),
    file: z.string().describe("Path to the implicated file, relative to the repo root."),
    lines: z
        .string()
        .optional()
        .describe("Line or line range within the file that contains the cause, e.g. '42' or '42-58'."),
});
export type CodeReference = z.infer<typeof codeReferenceSchema>;

/**
 * Grounds a suspected `application_bug` in concrete code. Produced by the
 * reviewer (and re-derived independently by the healing agent) to force every
 * customer-facing bug to point at a real cause rather than a plausible-sounding
 * theory. A finding that cannot be grounded must instead be classified as
 * `unknown_issue`.
 */
export const suspectedCauseSchema = z.object({
    explanation: z
        .string()
        .describe("How the referenced code produces the observed misbehavior - ties the cause to the symptom."),
    codeReferences: z
        .array(codeReferenceSchema)
        .min(1)
        .describe("At least one concrete code location implicated in the bug."),
});
export type SuspectedCause = z.infer<typeof suspectedCauseSchema>;
