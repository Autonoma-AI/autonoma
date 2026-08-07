import { deriveAnalysisVerdict } from "@autonoma/types";
import type { CheckRunConclusion } from "../github-installation-client";

/**
 * The stable check name branch protection matches by.
 */
export const MERGE_GATE_CHECK_NAME = "Autonoma";

/**
 * The `Autonoma` check state while an analysis run is in flight, before the worker posts the real verdict. Shared
 * so the API's on-demand triggers and the worker's auto-run-on-ready `openMergeGate` render the identical state.
 */
export const MERGE_GATE_IN_PROGRESS_TITLE = "Analyzing this PR";
export const MERGE_GATE_IN_PROGRESS_SUMMARY = "Autonoma is analyzing this PR for client bugs.";
/** Sentinel conclusion stored while a run is in flight - non-`failure`, so skip/bypass treat it as not-yet-blocking. */
export const MERGE_GATE_IN_PROGRESS_CONCLUSION = "in_progress";

/**
 * The PR comment announcing that a requested analysis run started, so the trigger's effect is visible in the
 * conversation.`actorLogin` attributes it to whoever asked (absent for the automatic auto-run-on-ready trigger).
 */
export function buildAnalyzingCommentBody(actorLogin?: string): string {
    const requester = actorLogin != null ? ` (requested by @${actorLogin})` : "";
    return `🔍 Autonoma is analyzing this PR${requester}. This can take a few minutes.`;
}

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

/** How many bug titles to list in the check summary before collapsing the rest into a "+N more" line. */
const MAX_LISTED_BUGS = 10;

export interface MergeGateVerdictInput {
    /** The authoritative app-health verdict from `AnalysisReport.verdict`. */
    verdict: "client_bug" | "passed";
    /** True when the analysis job errored (no trustworthy verdict). */
    errored: boolean;
    /** Count of coverage-plane findings (gaps). On a `passed` verdict, >0 downgrades success to a neutral warning. */
    coverageGapCount: number;
    /** Tests that produced a terminal verdict this run; zero means nothing was exercised. */
    investigatedCount: number;
    /**
     * Titles of the branch's OPEN bug issues - the same rows the verdict counts and the PR comment cards - listed in
     * the failure summary, most severe first.
     */
    clientBugTitles: string[];
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

    // The headlines are the branch's open bug issues, the same rows the verdict counts, so they normally agree. Floor
    // the count at one anyway: a bug resolved between the report being written and this check running would otherwise
    // block under a "0 client bugs" title.
    const bugCount = input.verdict === "client_bug" ? Math.max(input.clientBugTitles.length, 1) : 0;
    const state = deriveAnalysisVerdict({
        bugCount,
        coverageGapCount: input.coverageGapCount,
        investigatedCount: input.investigatedCount,
    });

    if (state === "bug_found") {
        return {
            conclusion: "failure",
            title: bugTitle(bugCount),
            summary: buildBugSummary(input.clientBugTitles),
        };
    }

    // A decision, so it passes the check rather than sitting in the neutral bucket the reader reads as unresolved.
    // `success` does not gate the merge, so the title is what tells this apart from a run that verified the change.
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
                `Autonoma found no client bugs, but ${input.coverageGapCount} check(s) did not complete, so the ` +
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
    // Nothing to list means the open bugs moved between the report and this check; point at the comment rather than
    // blocking under a summary that names nothing.
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
