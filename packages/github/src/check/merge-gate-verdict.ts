import type { AnalysisVerdictSummary } from "@autonoma/types";
import type { CheckRunConclusion } from "../github-installation-client";

/** Branch protection matches on this string, so it cannot change without breaking every configured ruleset. */
export const MERGE_GATE_CHECK_NAME = "Autonoma";

/** Shared, so the API's on-demand triggers and the worker's auto-run render the identical in-flight state. */
export const MERGE_GATE_IN_PROGRESS_TITLE = "Analyzing this PR";
export const MERGE_GATE_IN_PROGRESS_SUMMARY = "Autonoma is analyzing this PR for client bugs.";
/** Sentinel conclusion stored while a run is in flight - non-`failure`, so skip/bypass treat it as not-yet-blocking. */
export const MERGE_GATE_IN_PROGRESS_CONCLUSION = "in_progress";

/** `actorLogin` attributes the run to whoever asked; absent for the automatic auto-run-on-ready trigger. */
export function buildAnalyzingCommentBody(actorLogin?: string): string {
    const requester = actorLogin != null ? ` (requested by @${actorLogin})` : "";
    return `🔍 Autonoma is analyzing this PR${requester}. This can take a few minutes.`;
}

export const MERGE_GATE_SKIP_COMMAND = "/autonoma-skip";

/** Requires the check on ALL branches, so a PR is gated regardless of its base branch. */
export const MERGE_GATE_RULESET_NAME = "Autonoma merge gate";

export const MERGE_GATE_SKIP_COMMENT_MARKER = "autonoma:merge-gate-skip:v1";

/** How many bug titles to list in the check summary before collapsing the rest into a "+N more" line. */
const MAX_LISTED_BUGS = 10;

export interface MergeGateVerdictInput {
    /** True when the analysis job errored or never reached a verdict, so there is nothing trustworthy to gate on. */
    errored: boolean;
    /** The PR's resolved verdict and the counts behind it, from `BranchLedger.verdict()`. */
    verdict: AnalysisVerdictSummary;
    /**
     * Titles of the branch's OPEN bug issues - the same rows `verdict.bugCount` counts and the PR comment cards -
     * listed in the failure summary, most severe first.
     */
    clientBugTitles: string[];
}

export interface MergeGateCheckResult {
    /** `success` (clean) | `failure` (blocks; skip via the `/autonoma-skip` comment) | `neutral` (mergeable warning / fail-open). */
    conclusion: Extract<CheckRunConclusion, "success" | "failure" | "neutral">;
    title: string;
    summary: string;
}

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

    const { state, bugCount, coverageGapCount } = input.verdict;

    if (state === "bug_found") {
        return {
            conclusion: "failure",
            title: bugTitle(bugCount),
            summary: buildBugSummary(input.clientBugTitles),
        };
    }

    // A decision, not an unresolved run - so `success`, and the title is what tells it apart from a verified one.
    if (state === "no_tests_needed") {
        return {
            conclusion: "success",
            title: "No tests needed for this change",
            summary:
                "Autonoma reviewed this change and decided it needed no browser test: no existing test was affected, " +
                "and no new one was worth authoring. See the Autonoma PR comment for why.",
        };
    }

    if (state === "not_confirmed") {
        return {
            conclusion: "neutral",
            title: "Could not confirm this change",
            summary:
                `Autonoma found no client bugs, but ${coverageGapCount} check(s) did not complete, so the ` +
                "change was not fully verified. These fall on the coverage plane and do not block the merge.",
        };
    }

    return {
        conclusion: "success",
        title: "No blocking issues found",
        summary: "Autonoma verified this change and found no client bugs in this PR.",
    };
}

function bugTitle(count: number): string {
    return count === 1 ? "Autonoma found 1 client bug" : `Autonoma found ${count} client bugs`;
}

function buildBugSummary(headlines: string[]): string {
    const intro =
        `Autonoma found client bugs that block this merge. Fix them, or comment \`${MERGE_GATE_SKIP_COMMAND} <reason>\` ` +
        "on the PR to merge anyway.";
    // A blocking check that names no bug reads as a mistake, so point at where they are listed.
    if (headlines.length === 0) {
        return [intro, "", "See the Autonoma PR comment for the bugs that block this merge."].join("\n");
    }

    const listed = headlines.slice(0, MAX_LISTED_BUGS).map((headline) => `- ${headline}`);
    const overflow = headlines.length - MAX_LISTED_BUGS;
    const lines = [intro, "", ...listed];
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
