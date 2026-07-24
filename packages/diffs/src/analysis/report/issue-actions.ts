import { FixableToolError } from "@autonoma/ai";
import { suspectedCauseSchema } from "@autonoma/types";
import { z } from "zod";
import { reporterIssueKindSchema, reporterIssueSeveritySchema } from "./types";

/**
 * The content core shared across the Reporter's issue tools, plus the recorded-action shapes the loop collects.
 * Each tool owns its own input schema (in its own file) and declares exactly the fields it needs - no single
 * flexible `report_issue` with conditional fields, which behaves as badly on the wire as a union - but the
 * `open_issue` / `carry_forward_issue` schemas share this authored-content core, so it lives here.
 */

/** The content core shared by `open_issue` and `carry_forward_issue` - everything the model authors for an issue. */
export const authoredIssueContentSchema = z.object({
    title: z.string().min(1).describe("A short, specific title for the problem (what is broken, not the test name)."),
    kind: reporterIssueKindSchema.describe(
        "The class of problem: `bug` (the app misbehaves), `environment` (a preview key/flag/service is wrong), or `scenario` (the seeded data/auth is missing or wrong).",
    ),
    severity: reporterIssueSeveritySchema.describe("How severe the problem is for a real user."),
    expectedBehavior: z
        .string()
        .optional()
        .describe("What the app should have done. Omit only when it genuinely cannot be stated."),
    actualBehavior: z.string().min(1).describe("What the app actually did, grounded in the evidence you inspected."),
    narrativeMarkdown: z
        .string()
        .min(1)
        .describe(
            "The 'why this is a problem' narrative in Markdown. Weave in the concrete evidence you inspected; embed a fetched screenshot inline with `![caption](evidence:<assetId>)`, using only an assetId that `fetch_evidence` returned to you - never a raw URL or an id you did not fetch. Any image src that is not a fetched evidence token is stripped and renders as nothing.",
        ),
    findingSlugs: z
        .array(z.string())
        .min(1)
        .describe("Every one of THIS job's finding slugs that manifests this problem (at least one)."),
    suspectedCause: suspectedCauseSchema
        .optional()
        .describe(
            "The hedged, code-level cause (explanation + file:line references you read via `bash`). Each reference is validated against the checked-out repo at persist time - a reference whose file/lines/snippet does not match is dropped, so only code you actually read survives. Omit for environment/scenario issues or when you could not ground a cause.",
        ),
    primaryScreenshotAssetId: z
        .string()
        .optional()
        .describe(
            "The assetId of the fetched screenshot that best shows the problem, to feature as the issue's hero. Must be an id you fetched via `fetch_evidence`; an unfetched/unknown id is dropped.",
        ),
    primaryFindingSlug: z
        .string()
        .min(1)
        .describe(
            "Which ONE of the `findingSlugs` you just listed reproduces this problem most clearly - the run a reader should watch to see it happen. Pick the test whose failure demonstrates the problem most directly, not merely the first one.",
        ),
});

export type AuthoredIssueContent = z.infer<typeof authoredIssueContentSchema>;

/**
 * Reject a `primaryFindingSlug` the same call did not list in `findingSlugs`. That slug is what readers resolve an
 * issue's clip and "watch the run" deep-link from, so it has to name a test the issue genuinely covers. A fixable
 * error rather than a silent drop: the model can simply pick again from a list it authored one field earlier.
 */
export function assertPrimaryFindingSlugCovered(content: AuthoredIssueContent): void {
    if (!content.findingSlugs.includes(content.primaryFindingSlug)) {
        throw new FixableToolError(
            `primaryFindingSlug "${content.primaryFindingSlug}" is not one of this issue's findingSlugs (${content.findingSlugs.join(", ")}). Designate one of the slugs you listed.`,
        );
    }
}

/** A recorded `open_issue` call. */
export interface RecordedOpenIssueAction {
    kind: "open";
    content: AuthoredIssueContent;
}

/** A recorded `carry_forward_issue` call. */
export interface RecordedCarryForwardIssueAction {
    kind: "carry_forward";
    existingIssueId: string;
    content: AuthoredIssueContent;
}

/** A recorded `resolve_issue` call. */
export interface RecordedResolveIssueAction {
    kind: "resolve";
    existingIssueId: string;
    resolvingFindingSlug: string;
    note: string;
}

export type RecordedIssueAction =
    | RecordedOpenIssueAction
    | RecordedCarryForwardIssueAction
    | RecordedResolveIssueAction;
