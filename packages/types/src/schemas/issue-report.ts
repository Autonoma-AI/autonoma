import { z } from "zod";
import { overlayPointSchema } from "../types/step-overlay-points";
import { suspectedCauseSchema } from "./suspected-cause";

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
 * One asset the narrative may embed inline, anchored by a stable `assetId` that
 * traces to a concrete step artifact the healing agent actually fetched (a step's
 * before/after screenshot). The narrative references it by token
 * (`![](evidence:<assetId>)`), never by raw URL; the manifest is what the backend
 * resolves those tokens against at detail-build time.
 *
 * Built from the agent's fetched evidence by the report tool - never authored by
 * the model - so an asset can only reach the manifest (and thus the page) if it
 * was really fetched. `s3Key` is internal: it never leaves the server; the API
 * signs it into a short-lived URL when it resolves the narrative's tokens.
 */
export const evidenceManifestEntrySchema = z.object({
    assetId: z
        .string()
        .describe(
            "Stable id tracing to the concrete fetched artifact; what the narrative references via `evidence:<assetId>`.",
        ),
    s3Key: z
        .string()
        .describe("Internal storage key for the asset; resolved to a signed URL server-side, never sent raw."),
    kind: z.enum(["screenshot", "step_output"]),
    pin: overlayPointSchema
        .optional()
        .describe("The resolved interaction point drawn over the screenshot (e.g. the click target)."),
});

export type EvidenceManifestEntry = z.infer<typeof evidenceManifestEntrySchema>;

/**
 * The text core of the report, authored by the healing agent from the evidence it
 * fetched. This is exactly what the model emits on a `report_bug`; the evidence
 * manifest is *not* here - it is derived from the agent's actual fetches by the
 * report tool, so the model cannot fabricate a manifest entry.
 */
export const authoredIssueReportSchema = z.object({
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
            "The rich 'why this is a bug' narrative in Markdown: walk the reader through what happened and why it is wrong, weaving in the concrete evidence (screenshots, step outputs) you inspected. Embed a fetched screenshot inline with `![caption](evidence:<assetId>)`, using only an assetId that `fetch_step_evidence` returned to you - never a raw URL, never a storage path you construct yourself, never an id you did not fetch. Any image src that is not a returned evidence token is stripped and renders as nothing.",
        ),
});

export type AuthoredIssueReport = z.infer<typeof authoredIssueReportSchema>;

/**
 * The customer-facing bug report the healing agent authors once it can fetch the
 * failure's evidence. Persisted as a single Zod-validated JSON blob on
 * `Issue.report` (per occurrence - each detection has its own run/screenshots)
 * and rendered on the bug detail page's "Why this is a bug" section.
 *
 * A single nested object rather than flat columns because the report grows
 * additional fields (`primaryScreenshot`, `suspectedCause`), all authored by the
 * same healing pass. The `evidenceManifest` extends the authored text core with
 * the assets the narrative may embed inline; it is system-derived, not authored.
 */
export const issueReportSchema = authoredIssueReportSchema.extend({
    evidenceManifest: z
        .array(evidenceManifestEntrySchema)
        .optional()
        .describe(
            "Every asset the narrative may reference by `evidence:<assetId>` token. Derived from the agent's fetched evidence, not authored - a token with no manifest entry resolves to nothing (never a broken image).",
        ),
    // The hedged code-level cause, rendered below the proven case as a subordinate
    // "Suspected cause" section - never as "Root cause". Captured from the healing
    // action's grounded `suspectedCause` at apply time rather than re-authored here,
    // so it stays the code the agent actually read. Omitted when no cause was grounded.
    suspectedCause: suspectedCauseSchema
        .optional()
        .describe(
            "The suspected code-level cause (explanation + grounded file:line references). Surfaced as a hedged, subordinate section, so a wrong guess never contaminates the proven case above it.",
        ),
    primaryScreenshot: primaryScreenshotSchema.optional(),
});

export type IssueReport = z.infer<typeof issueReportSchema>;
