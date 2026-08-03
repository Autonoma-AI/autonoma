import { z } from "zod";

/** GitHub caps a label name at 50 characters. */
const MAX_LABEL_LENGTH = 50;

/** Control characters GitHub rejects in a label name (newlines, tabs, the rest of the C0 range, and DEL). */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/**
 * A GitHub-label-legal analysis-trigger label: non-empty once trimmed, at most 50 characters, and free of
 * control characters.
 */
export const AnalysisTriggerLabelSchema = z
    .string()
    .trim()
    .min(1, "Label cannot be empty")
    .max(MAX_LABEL_LENGTH, `Label must be at most ${MAX_LABEL_LENGTH} characters`)
    .refine((value) => !CONTROL_CHARS.test(value), "Label cannot contain control characters");

/** The per-repo trigger settings the config page reads and writes. */
export const TriggerConfigSchema = z.object({
    /** Whether marking a PR ready-for-review automatically starts an analysis run. */
    autoRunOnReadyForReview: z.boolean(),
    /** The PR label whose addition starts an analysis run. */
    analysisTriggerLabel: AnalysisTriggerLabelSchema,
});
export type TriggerConfig = z.infer<typeof TriggerConfigSchema>;
