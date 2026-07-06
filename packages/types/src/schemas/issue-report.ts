import { z } from "zod";

/**
 * The customer-facing bug report the healing agent authors once it can fetch the
 * failure's evidence. Persisted as a single Zod-validated JSON blob on
 * `Issue.report` (per occurrence - each detection has its own run/screenshots)
 * and rendered on the bug detail page's "Why this is a bug" section.
 *
 * A single nested object rather than flat columns because the report grows
 * additional fields (`primaryScreenshot`, `evidenceManifest`, `suspectedCause`),
 * all authored by the same healing pass.
 */
export const issueReportSchema = z.object({
    expectedBehavior: z
        .string()
        .optional()
        .describe(
            "What the application should have done - the Expected side of the case. Omit only when the correct behavior genuinely cannot be stated; the page then shows Actual alone rather than a fabricated Expected.",
        ),
    actualBehavior: z
        .string()
        .describe(
            "What the application actually did, grounded in the evidence you fetched - the Actual side of the case.",
        ),
    narrativeMarkdown: z
        .string()
        .describe(
            "The rich 'why this is a bug' narrative in Markdown: walk the reader through what happened and why it is wrong, weaving in the concrete evidence (screenshots, step outputs) you inspected.",
        ),
});

export type IssueReport = z.infer<typeof issueReportSchema>;
