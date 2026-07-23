import type { CheckRunAction, CheckRunConclusion } from "../github-installation-client";

/**
 * The stable check name branch protection matches by.
 */
export const MERGE_GATE_CHECK_NAME = "Autonoma";

/** The `identifier` on the Skip button; the `requested_action` webhook echoes it so we know a skip was clicked. */
export const MERGE_GATE_SKIP_ACTION_IDENTIFIER = "autonoma-skip";

/**
 * Name of the repository ruleset we create to require the `Autonoma` check on ALL branches, so every PR the client
 * opens is gated regardless of its base branch.
 */
export const MERGE_GATE_RULESET_NAME = "Autonoma merge gate";

/** How many client-bug headlines to list in the check summary before collapsing the rest into a "+N more" line. */
const MAX_LISTED_BUGS = 10;

/** The Skip button. */
const SKIP_ACTION: CheckRunAction = {
    label: "Skip check",
    description: "Merge past Autonoma's blocking findings",
    identifier: MERGE_GATE_SKIP_ACTION_IDENTIFIER,
};

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
    /** `success` (clean) | `failure` (blocks, with Skip) | `neutral` (mergeable warning / fail-open). */
    conclusion: Extract<CheckRunConclusion, "success" | "failure" | "neutral">;
    title: string;
    summary: string;
    /** The Skip action, present only on a blocking `failure`. */
    actions?: CheckRunAction[];
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
            actions: [SKIP_ACTION],
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
        "Autonoma found client bugs that block this merge. Fix them, or click **Skip check** to merge anyway.",
        "",
        ...listed,
    ];
    if (overflow > 0) lines.push(`- ...and ${overflow} more`);
    return lines.join("\n");
}
