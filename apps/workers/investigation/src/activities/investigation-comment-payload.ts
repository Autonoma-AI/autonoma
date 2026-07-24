import { buildAgentHandoffLinks, capHandoffPrompt } from "@autonoma/github/comment";
import type {
    AutonomaCommentBug,
    AutonomaCommentCta,
    AutonomaCommentHandoff,
    AutonomaCommentPayload,
    AutonomaCommentState,
    AutonomaCommentStats,
} from "@autonoma/github/comment";
import type { InvestigationTestResult } from "@autonoma/workflow/activities";

/** Verdict categories that warrant action (a "warning" state) when there are no outright client bugs. */
const ACTIONABLE_CATEGORIES = new Set(["scenario_issue", "environment_failure", "outdated_test", "bad_test"]);

/** A `passed` result is the absence of a finding to act on, so it is the one category never shown as a card. */
const HIDDEN_CATEGORY = "passed";

/** The subset of comment states a single finding can carry: client bug, actionable issue, or engine artifact. */
type FindingMarker = Extract<AutonomaCommentState, "critical" | "warning" | "incomplete">;

/**
 * A finding's severity in the comment-state vocabulary: a client bug is `critical`, an actionable issue
 * `warning`, and everything else (engine artifacts) `incomplete` - the flow never truly ran. This one mapping
 * drives both the per-finding row color and the sort order, so the two can never drift apart.
 */
function findingMarkerState(category: string): FindingMarker {
    if (category === "client_bug") return "critical";
    if (ACTIONABLE_CATEGORIES.has(category)) return "warning";
    return "incomplete";
}

/** Findings sort by severity: client bugs first, then actionable issues, then informational ones (engine artifacts). */
const FINDING_RANK: Record<FindingMarker, number> = { critical: 0, warning: 1, incomplete: 2 };

function findingRank(result: InvestigationTestResult): number {
    return FINDING_RANK[findingMarkerState(result.verdict?.category ?? "")];
}

export interface InvestigationCommentContext {
    prNumber: number;
    commitSha: string;
    /** The in-app PR overview page URL (".../pull-requests/<n>/"); the top-level "Open in Autonoma" CTA lands here. */
    prUrl: string;
    /** The in-app report base URL for this snapshot (".../investigation"); per-finding "See full report" links append the slug. */
    reportBaseUrl: string;
    /** The preview environment URL for the branch, if deployed. */
    previewUrl?: string;
    /** Base URL the comment's status/CTA image assets are served from. */
    assetBaseUrl: string;
    /** GitHub repo "owner/name" - fed to the coding-agent handoff (e.g. Claude Code's `repositories=` param). */
    repoFullName: string;
    /** Test stats from the primary checkpoint (dashboard parity); undefined when there is no checkpoint. */
    stats?: AutonomaCommentStats;
    /** Headline to use when the twin surfaced no findings - already reconciled with the primary checkpoint. */
    checkpointHeadline: string;
}

/**
 * Build the shared GitHub-comment payload from the investigation's classified results. Client bugs make the
 * comment UNHEALTHY; otherwise actionable findings (scenario/env/test issues) make it a WARNING; a clean run is
 * HEALTHY. Every finding is listed - not just client bugs - so a reviewer sees the full picture: client bugs
 * lead, then actionable issues, then informational ones (engine artifacts). Only a `passed` result is withheld,
 * since it is not a finding. Each shown finding becomes a rich bug collapsible; screenshots are signed via the
 * injected signer.
 */
export async function buildInvestigationCommentPayload(
    results: InvestigationTestResult[],
    context: InvestigationCommentContext,
    signScreenshot: (s3Url: string) => Promise<string | undefined>,
): Promise<AutonomaCommentPayload> {
    const clientBugs = results.filter((result) => result.verdict?.category === "client_bug");
    const actionables = results.filter((result) => ACTIONABLE_CATEGORIES.has(result.verdict?.category ?? ""));

    const shown = results
        .filter((result) => (result.verdict?.category ?? "") !== HIDDEN_CATEGORY)
        .sort((a, b) => findingRank(a) - findingRank(b));

    // Client bugs make it critical; actionable findings a warning; engine-artifact-only means the runner never
    // executed the flow, so it is "not fully tested" (never "healthy" - we can't claim no issues when nothing ran).
    const state: AutonomaCommentState =
        clientBugs.length > 0
            ? "critical"
            : actionables.length > 0
              ? "warning"
              : shown.length > 0
                ? "incomplete"
                : "healthy";

    const bugs = await Promise.all(shown.map((result) => toBug(result, context, signScreenshot)));

    const ctas: AutonomaCommentCta[] = [{ label: "Open in Autonoma", href: context.prUrl }];
    if (context.previewUrl != null && context.previewUrl !== "") {
        ctas.push({ label: "See preview", href: context.previewUrl });
    }

    return {
        state,
        prNumber: context.prNumber,
        headline: buildHeadline(state, clientBugs.length, actionables.length, context.checkpointHeadline),
        stats: context.stats,
        commitRef: context.commitSha.slice(0, 7),
        assetBaseUrl: context.assetBaseUrl,
        ctas,
        services: [],
        addons: [],
        warnings: [],
        details: [],
        bugs,
        // Only offer the handoff when there is something to fix.
        handoff: shown.length > 0 ? buildHandoff(shown, context) : undefined,
    };
}

/**
 * The "hand off to a coding agent" block: a full paste-ready prompt (findings + evidence) plus "open in <agent>"
 * deep-links that prefill a short kickoff prompt. The deep-links use only https schemes - GitHub strips custom
 * schemes (cursor://, claude-cli://) from comment markdown - and each opens the agent prefilled for the dev to
 * review and send; none auto-run. Full content rides the copy block, since URLs are length-capped.
 */
function buildHandoff(shown: InvestigationTestResult[], context: InvestigationCommentContext): AutonomaCommentHandoff {
    // The deep-links carry the SAME full prompt as the copy block (findings + evidence), not a short kickoff -
    // the agent should open with the whole context. Big prompts make long URLs: Claude Code accepts them
    // (~14k chars), while Cursor/ChatGPT truncate very large ones at their URL limits, so the copy block stays
    // the reliable full source. A signed prompt_url would carry it losslessly (follow-up).
    const prompt = capHandoffPrompt(buildHandoffPrompt(shown, context), context.prUrl);
    return { prompt, links: buildAgentHandoffLinks(prompt, context.repoFullName) };
}

function buildHandoffPrompt(shown: InvestigationTestResult[], context: InvestigationCommentContext): string {
    const header = [
        `Fix the following bug(s) Autonoma found in pull request ${context.repoFullName}#${context.prNumber} (commit ${context.commitSha.slice(0, 7)}).`,
        "Each finding gives what happened, the likely root cause, the file:line evidence, and a suggested fix. Apply the fixes, then re-run the affected flows to confirm.",
        // The in-app report links below require an Autonoma login; the MCP is the auth-free channel for an agent.
        `Live findings via MCP: connect the Autonoma MCP (\`claude mcp add --transport http autonoma https://api.autonoma.app/v1/mcp/debug\`, or your client's MCP config) and call \`get_investigation(repoFullName="${context.repoFullName}", prNumber=${context.prNumber})\` for these findings + evidence live; it also exposes this PR's deploy status and build/app logs.`,
    ].join("\n\n");
    const findings = shown.map((result, index) => renderFindingForPrompt(result, index + 1, context));
    return [header, ...findings, `Full report (login required): ${context.prUrl}`].join("\n\n");
}

function renderFindingForPrompt(
    result: InvestigationTestResult,
    index: number,
    context: InvestigationCommentContext,
): string {
    const verdict = result.verdict;
    const parts = [`## ${index}. ${verdict?.headline ?? result.slug}`];
    if (verdict?.whatHappened != null && verdict.whatHappened !== "")
        parts.push(`What happened: ${verdict.whatHappened}`);
    if (verdict?.rootCause != null && verdict.rootCause !== "") parts.push(`Root cause: ${verdict.rootCause}`);
    if (verdict?.observedAppIssues != null && verdict.observedAppIssues !== "")
        parts.push(`Observed app issues: ${verdict.observedAppIssues}`);
    const remediation = remediationWithRoute(result);
    if (remediation != null && remediation !== "") parts.push(`Suggested fix: ${remediation}`);
    const evidence = (verdict?.evidence ?? []).map(renderEvidenceForPrompt);
    if (evidence.length > 0) parts.push(`Evidence:\n${evidence.join("\n")}`);
    parts.push(`Details: ${context.reportBaseUrl}/${encodeURIComponent(result.slug)}`);
    return parts.join("\n");
}

function renderEvidenceForPrompt(item: NonNullable<InvestigationTestResult["verdict"]>["evidence"][number]): string {
    const location = item.file != null ? ` ${item.file}${item.lines != null ? `:${item.lines}` : ""}` : "";
    const detail = item.detail != null && item.detail !== "" ? ` - ${item.detail}` : "";
    const head = `- [${item.source}]${location}${detail}`;
    if (item.snippet == null || item.snippet === "") return head;
    return `${head}\n\`\`\`\n${item.snippet}\n\`\`\``;
}

/**
 * Findings first, checkpoint second: client bugs (critical) count as bugs, actionable findings (warning) count
 * as warnings; an engine-artifact-only run (incomplete) never ran the flow, so it says so; a findings-clean
 * comment defers to the primary checkpoint's headline. Each count is the matching subset, never the total.
 */
function buildHeadline(
    state: AutonomaCommentState,
    clientBugCount: number,
    actionableCount: number,
    checkpointHeadline: string,
): string {
    if (state === "critical") {
        return `Autonoma found ${clientBugCount} ${clientBugCount === 1 ? "bug" : "bugs"} in this PR.`;
    }
    if (state === "warning") {
        return `Autonoma raised ${actionableCount} ${actionableCount === 1 ? "warning" : "warnings"} in this PR.`;
    }
    if (state === "incomplete") return "Autonoma couldn't fully test this PR.";
    return checkpointHeadline;
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
    // Prefer the animated GIF clip of the failure (client bugs) over the static final screenshot; both embed
    // as an <img> in the comment, and GitHub renders animated GIFs inline.
    const mediaKey = result.clipUrl ?? result.finalScreenshotUrl;
    const screenshotUrl = mediaKey != null ? await signScreenshot(mediaKey) : undefined;
    // "Watch replay" is only worth surfacing for a confirmed client bug that actually has a recording clip -
    // otherwise there is no replay to watch and the link is just a duplicate of "See full report". Warnings
    // (scenario/env/test issues) never get it; the screenshot links to the report instead.
    const replayHref = verdict?.category === "client_bug" && result.clipUrl != null ? findingUrl : undefined;
    return {
        title: verdict?.headline ?? result.slug,
        href: findingUrl,
        markerState: findingMarkerState(verdict?.category ?? ""),
        replayHref,
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
