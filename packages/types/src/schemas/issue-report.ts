import { z } from "zod";

/** A coordinate in the screenshot's own pixel space, used to draw the hero pin. */
export const screenshotPinSchema = z.object({
    x: z.number(),
    y: z.number(),
});
export type ScreenshotPin = z.infer<typeof screenshotPinSchema>;

/**
 * The frame healing designates as the clearest view of the bug, resolved to a
 * concrete storage key (never authored raw by the model - the tool resolves the
 * step reference the agent picks against the failure's real captured screenshots,
 * so a hallucinated key can never be persisted). `pin` marks where in the frame
 * the relevant element sits, when the referenced step resolved a point. The API
 * signs `s3Key` into the hero; when this is absent the hero falls back to the
 * run's failing-step screenshot.
 */
export const primaryScreenshotSchema = z.object({
    s3Key: z.string(),
    pin: screenshotPinSchema.optional(),
});
export type PrimaryScreenshot = z.infer<typeof primaryScreenshotSchema>;

/**
 * The customer-facing bug report the healing agent authors once it can fetch the
 * failure's evidence. Persisted as a single Zod-validated JSON blob on
 * `Issue.report` (per occurrence - each detection has its own run/screenshots)
 * and rendered on the bug detail page's "Why this is a bug" section.
 *
 * A single nested object rather than flat columns because the report grows
 * additional fields (`evidenceManifest`, `suspectedCause`), all authored by the
 * same healing pass.
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
    primaryScreenshot: primaryScreenshotSchema.optional(),
});

export type IssueReport = z.infer<typeof issueReportSchema>;
