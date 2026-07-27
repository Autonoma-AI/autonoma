import type { CheckRunConclusion } from "../github-installation-client";

/**
 * The stable check name branch protection matches by.
 */
export const MERGE_GATE_CHECK_NAME = "Autonoma";

/**
 * The slash command a developer comments on the PR to skip a blocking check.
 */
export const MERGE_GATE_SKIP_COMMAND = "/autonoma-skip";

/**
 * Name of the repository ruleset we create to require the `Autonoma` check on ALL branches, so every PR the client
 * opens is gated regardless of its base branch.
 */
export const MERGE_GATE_RULESET_NAME = "Autonoma merge gate";

/**
 * Hidden marker on the standalone skip-attribution comment.
 */
export const MERGE_GATE_SKIP_COMMENT_MARKER = "autonoma:merge-gate-skip:v1";

/** How many client-bug headlines to list in the check summary before collapsing the rest into a "+N more" line. */
const MAX_LISTED_BUGS = 10;

export interface MergeGateVerdictInput {
    /** The authoritative app-health verdict from `AnalysisReport.verdict`. */
    verdict: "client_bug" | "passed";
    /** True when the analysis job errored (no trustworthy verdict). */
    errored: boolean;
    /** Count of coverage-plane findings (gaps). On a `passed` verdict, >0 downgrades success to a neutral warning. */
    coverageGapCount: number;
    /** Headlines of the `client_bug` findings, listed in the failure summary. */
    clientBugHeadlines: string[];
}

export interface MergeGateCheckResult {
    /** `success` (clean) | `failure` (blocks; skip via the `/autonoma-skip` comment) | `neutral` (mergeable warning / fail-open). */
    conclusion: Extract<CheckRunConclusion, "success" | "failure" | "neutral">;
    title: string;
    summary: string;
}

/**
 * Map the authoritative verdict to the `Autonoma` check-run result.
 */
export function buildMergeGateCheckResult(input: MergeGateVerdictInput): MergeGateCheckResult {
    if (input.errored) {
        return {
            conclusion: "neutral",
            title: "Autonoma could not complete its analysis",
            summary:
                "The Autonoma analysis did not finish, so this check does not block the merge. " +
                "Re-run the analysis to get a verdict.",
        };
    }

    if (input.verdict === "client_bug") {
        return {
            conclusion: "failure",
            title: bugTitle(input.clientBugHeadlines.length),
            summary: buildBugSummary(input.clientBugHeadlines),
        };
    }

    if (input.coverageGapCount > 0) {
        return {
            conclusion: "neutral",
            title: "No blocking issues found (with coverage gaps)",
            summary:
                `Autonoma found no client bugs. ${input.coverageGapCount} finding(s) fall on the coverage plane ` +
                "(not blocking); some flows could not be fully assessed.",
        };
    }

    return {
        conclusion: "success",
        title: "No blocking issues found",
        summary: "Autonoma ran and found no client bugs in this PR.",
    };
}

function bugTitle(count: number): string {
    return count === 1 ? "Autonoma found 1 client bug" : `Autonoma found ${count} client bugs`;
}

function buildBugSummary(headlines: string[]): string {
    const listed = headlines.slice(0, MAX_LISTED_BUGS).map((headline) => `- ${headline}`);
    const overflow = headlines.length - MAX_LISTED_BUGS;
    const lines = [
        `Autonoma found client bugs that block this merge. Fix them, or comment \`${MERGE_GATE_SKIP_COMMAND} <reason>\` ` +
            "on the PR to merge anyway.",
        "",
        ...listed,
    ];
    if (overflow > 0) lines.push(`- ...and ${overflow} more`);
    return lines.join("\n");
}

/**
 * Parse a PR comment body as the skip command. Returns the (optional) free-text reason when the comment is a skip
 * command, or `undefined` when it is any other comment.
 */
export function parseSkipCommand(commentBody: string): { reason?: string } | undefined {
    const trimmed = commentBody.trim();
    if (!trimmed.startsWith(MERGE_GATE_SKIP_COMMAND)) return undefined;

    const rest = trimmed.slice(MERGE_GATE_SKIP_COMMAND.length);
    if (rest.length > 0 && !/^\s/.test(rest)) return undefined;
    const reason = rest.trim();
    return reason.length > 0 ? { reason } : {};
}
