import type {
    AutonomaCommentBug,
    AutonomaCommentCta,
    AutonomaCommentPayload,
    AutonomaCommentState,
} from "@autonoma/github/comment";
import type { InvestigationTestResult } from "@autonoma/workflow/activities";

/** Verdict categories that warrant action (a "warning" state) when there are no outright client bugs. */
const ACTIONABLE_CATEGORIES = new Set(["scenario_issue", "environment_failure", "outdated_test", "bad_test"]);

export interface InvestigationCommentContext {
    prNumber: number;
    commitSha: string;
    /** The in-app report base URL for this snapshot (".../investigation"); per-finding links append the slug. */
    reportBaseUrl: string;
    /** The preview environment URL for the branch, if deployed. */
    previewUrl?: string;
    /** Base URL the comment's status/CTA image assets are served from. */
    assetBaseUrl: string;
}

/**
 * Build the shared GitHub-comment payload from the investigation's classified results. Client bugs make the
 * comment UNHEALTHY; otherwise actionable findings (scenario/env/test issues) make it a WARNING; a clean run is
 * HEALTHY. Each shown finding becomes a rich bug collapsible. Screenshots are signed via the injected signer.
 */
export async function buildInvestigationCommentPayload(
    results: InvestigationTestResult[],
    context: InvestigationCommentContext,
    signScreenshot: (s3Url: string) => Promise<string | undefined>,
): Promise<AutonomaCommentPayload> {
    const clientBugs = results.filter((result) => result.verdict?.category === "client_bug");
    const actionables = results.filter((result) => ACTIONABLE_CATEGORIES.has(result.verdict?.category ?? ""));

    const state: AutonomaCommentState =
        clientBugs.length > 0 ? "critical" : actionables.length > 0 ? "warning" : "healthy";
    const shown = clientBugs.length > 0 ? clientBugs : actionables;

    const bugs = await Promise.all(shown.map((result) => toBug(result, context, signScreenshot)));

    const ctas: AutonomaCommentCta[] = [{ label: "Open in Autonoma", href: context.reportBaseUrl }];
    if (context.previewUrl != null && context.previewUrl !== "") {
        ctas.push({ label: "See preview", href: context.previewUrl });
    }

    return {
        state,
        prNumber: context.prNumber,
        headline: "",
        commitRef: context.commitSha.slice(0, 7),
        assetBaseUrl: context.assetBaseUrl,
        ctas,
        services: [],
        addons: [],
        warnings: [],
        details: [],
        bugs,
    };
}

/**
 * The remediation shown in the PR comment, enriched with the scenario-repair route when one was diagnosed. The
 * route tells the reader which lever to pull; for `recipe_and_sdk` this is the deliverable - the factory needs a
 * code change we cannot make, so we surface the concrete client-factory change right here (in our own comment, not
 * a separate one) so the client's coding agent has an actionable item. `fix_test`/`recipe_only` may already have
 * been written live (see `applied`); the proposed-recipe line notes that it is a dry-run unless autofix is on.
 */
function remediationWithRoute(result: InvestigationTestResult): string | undefined {
    const base = result.verdict?.remediation;
    const diagnosis = result.scenarioDiagnosis;
    if (diagnosis == null) return base;

    const factory =
        diagnosis.factoryIssue != null && diagnosis.factoryIssue !== ""
            ? ` Client factory change: ${diagnosis.factoryIssue}`
            : "";
    const proposed =
        diagnosis.proposedRecipeSummary != null && diagnosis.proposedRecipeSummary !== ""
            ? ` Proposed recipe: ${diagnosis.proposedRecipeSummary}`
            : "";
    const routeLine = `Repair route: \`${diagnosis.route}\` - ${diagnosis.reasoning}${factory}${proposed}${appliedNote(diagnosis)}`;
    return [base, routeLine].filter((part) => part != null && part !== "").join("\n\n");
}

/**
 * The repair outcome to show. recipe_and_sdk needs a client code change we can't make, so it stays a proposal.
 * For the other routes autofix VALIDATES the repair on the twin (branch-scoped) - it is never written to main
 * here; a validated test fix rides the branch and reaches main only when the PR merges. We report what happened:
 * validated on the twin, tried-but-not-validated (with the reason), or a dry-run because autofix is off.
 */
function appliedNote(diagnosis: NonNullable<InvestigationTestResult["scenarioDiagnosis"]>): string {
    if (diagnosis.route === "recipe_and_sdk")
        return " Requires a client code change (surfaced above); not auto-applied.";
    if (diagnosis.applied === true)
        return ` ${diagnosis.appliedNote ?? "Validated on the twin (branch-scoped); not written to main."}`;
    if (diagnosis.appliedNote != null && diagnosis.appliedNote !== "") return ` ${diagnosis.appliedNote}.`;
    return " Dry-run only (autofix disabled for this org).";
}

async function toBug(
    result: InvestigationTestResult,
    context: InvestigationCommentContext,
    signScreenshot: (s3Url: string) => Promise<string | undefined>,
): Promise<AutonomaCommentBug> {
    const verdict = result.verdict;
    const findingUrl = `${context.reportBaseUrl}/${encodeURIComponent(result.slug)}`;
    const screenshotUrl =
        result.finalScreenshotUrl != null ? await signScreenshot(result.finalScreenshotUrl) : undefined;
    return {
        title: verdict?.headline ?? result.slug,
        href: findingUrl,
        replayHref: findingUrl,
        screenshotUrl,
        description: verdict?.whatHappened,
        remediation: remediationWithRoute(result),
        evidence: (verdict?.evidence ?? []).map((item) => ({
            source: item.source,
            detail: item.detail,
            file: item.file,
            lines: item.lines,
            snippet: item.snippet,
        })),
        previewHref: context.previewUrl,
    };
}
