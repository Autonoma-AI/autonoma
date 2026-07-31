import type {
    SuiteHealthFixBranch,
    SuiteHealthFixCluster,
    SuiteHealthFixKind,
    SuiteHealthLevel,
} from "@autonoma/types";
import { suiteHealthFixKindSchema } from "@autonoma/types";

/**
 * The MCP server names our install snippets register. The prompt must name the debug one verbatim AND rule the
 * other one out: we publish two, "the Autonoma MCP" names both, and an agent holding only the onboarding server
 * has none of the tools below.
 */
const MCP_SERVER_NAME = "autonoma";
const ONBOARDING_MCP_SERVER_NAME = "autonoma-onboarding";

/** How many branches the prompt enumerates before collapsing the rest into a count. */
const MAX_LISTED_BRANCHES = 10;

/** Closed branches are reference material, not a work list, so they get a shorter leash than the open ones. */
const MAX_LISTED_CLOSED_BRANCHES = 5;

/**
 * Where each kind of finding is repaired, and with which tools. Lifted from the MCP server's own routing
 * instructions so an agent that reads only this prompt still reaches for the right tool - and so the two cannot
 * drift into contradicting each other.
 */
const KIND_ROUTING: Record<SuiteHealthFixKind, string> = {
    bug: "the app misbehaved. Fix it in this repo and push to the pull request's branch.",
    environment:
        "the preview could not run properly - a missing secret, a broken service. Fix it with get_secret_status / set_secret / edit_previewkit_config. No repo change needed.",
    scenario:
        "the test data was missing or wrong. Fix it with list_scenarios / get_recipe / update_recipe / dry_run_scenario. Takes effect with no redeploy.",
};

const LEVEL_LABEL: Record<SuiteHealthLevel, string> = {
    degraded: "DEGRADED (1/5)",
    at_risk: "AT RISK (2/5)",
    calibrating: "CALIBRATING (3/5)",
    steady: "STEADY (4/5)",
    proven: "PROVEN (5/5)",
};

export interface SuiteHealthFixPromptInput {
    level: SuiteHealthLevel;
    repoFullName?: string;
    openPullRequests: SuiteHealthFixBranch[];
    recentlyFailed: SuiteHealthFixBranch[];
    totalIssues: number;
    byKind: Record<SuiteHealthFixKind, number>;
    oldestAgeDays: number;
    /** True when the scan hit its cap, so the totals are a floor. Rendered as "at least N", never hidden. */
    truncated: boolean;
    /** Findings repeating across branches, most-shared first. Empty when nothing repeats. */
    clusters: SuiteHealthFixCluster[];
}

/**
 * Writes the prompt the user hands to their coding agent. It names the real branches, the real finding counts and
 * the real tools, because a prompt that describes the backlog in general terms makes the agent go rediscover it -
 * and rediscovery is the step that fails.
 *
 * Three things it is deliberately opinionated about:
 *
 * - **It names the debug server.** We publish two MCPs and "the Autonoma MCP" names both; an agent holding
 *   `autonoma-onboarding` has none of these tools and will flail.
 * - **Open pull requests first, not oldest first.** A closed pull request needs no fix - at most its logs explain
 *   a failure still live elsewhere - so leading with the oldest sends the agent at work nobody is waiting on.
 * - **Fix shared causes once.** The same failure typically lands on every open pull request at once, so the
 *   backlog is far smaller than its count suggests. Worked one at a time, an agent repairs one cause N times.
 *
 * It is NOT a list to apply blindly: the agent reads each finding through `get_analysis` first, and is told in as
 * many words not to silence a test to make a run go green.
 */
export function suiteHealthFixPrompt(input: SuiteHealthFixPromptInput): string {
    const lines: string[] = [];

    lines.push(
        `Use the \`${MCP_SERVER_NAME}\` MCP - the Autonoma DEBUG server, not \`${ONBOARDING_MCP_SERVER_NAME}\` - to work`,
    );
    lines.push("through this. Its tools are how you read each failure and fix it.");
    lines.push("");
    lines.push(`Autonoma reports SUITE HEALTH: ${LEVEL_LABEL[input.level]} for ${subject(input.repoFullName)}.`);
    lines.push(summarySentence(input));
    lines.push("");

    if (input.repoFullName == null) {
        lines.push("First resolve the repo: read the git remote (`git remote get-url origin` -> owner/repo), or");
        lines.push("call list_apps. Every tool below is keyed by that name.");
        lines.push("");
    }

    if (input.openPullRequests.length > 0) {
        lines.push("START HERE - open pull requests, blocked right now (most findings first):");
        lines.push(...branchLines(input.openPullRequests));
        lines.push("");
    }

    if (input.clusters.length > 0) {
        lines.push(...clusterSection(input.clusters));
        lines.push("");
    }

    if (input.recentlyFailed.length > 0) {
        lines.push("Already merged or closed - do NOT go fix these. They are here only because their runs may");
        lines.push("show the same failure with more evidence:");
        lines.push(...branchLines(input.recentlyFailed, MAX_LISTED_CLOSED_BRANCHES));
        lines.push("");
    }

    lines.push("For each finding, call get_analysis(repoFullName, prNumber) and read it. The finding's `kind`");
    lines.push("tells you where its fix lives:");
    lines.push("");
    for (const kind of orderedKinds(input.byKind)) {
        lines.push(`  \u00b7 ${kind.padEnd(11)} -> ${KIND_ROUTING[kind]}`);
    }
    lines.push("");
    lines.push("Do NOT disable, skip or delete a test to make a run go green - if a test is genuinely wrong about");
    lines.push("the app, say so and explain why rather than removing it quietly. Report what you changed, and");
    lines.push("which pull requests each change should clear.");

    return lines.join("\n");
}

/**
 * The batching instruction, and the numbers that justify it. Only rendered when findings actually repeat, so the
 * agent is never told to look for a shared cause that is not there.
 */
function clusterSection(clusters: SuiteHealthFixCluster[]): string[] {
    const lines = ["Most of this is probably ONE problem. These findings repeat across pull requests:"];

    for (const cluster of clusters) {
        const open = cluster.openBranches > 0 ? `, ${cluster.openBranches} still open` : "";
        lines.push(
            `  \u00b7 ${cluster.branches} pull requests${open} - ${cluster.findings} findings - "${cluster.title}"`,
        );
    }

    lines.push("");
    lines.push("Diagnose the shared cause FIRST and fix it once, then re-run and see how many clear before you");
    lines.push("move on. Do not work these one at a time - one fix often clears most of the backlog.");
    return lines;
}

function subject(repoFullName: string | undefined): string {
    return repoFullName ?? "this repository";
}

function summarySentence({ totalIssues, byKind, truncated }: SuiteHealthFixPromptInput): string {
    const breakdown = orderedKinds(byKind)
        .map((kind) => `${byKind[kind]} ${kind}`)
        .join(", ");
    const noun = totalIssues === 1 ? "finding is" : "findings are";
    const count = truncated ? `At least ${totalIssues}` : `${totalIssues}`;

    return `${count} ${noun} unresolved (${breakdown}).`;
}

/**
 * The kinds actually present, most-numerous first, so the routing list never explains a kind that is not there.
 * Derived from the schema rather than hand-listed: a fourth kind must appear here the day it is added.
 */
function orderedKinds(byKind: Record<SuiteHealthFixKind, number>): SuiteHealthFixKind[] {
    return suiteHealthFixKindSchema.options.filter((kind) => byKind[kind] > 0).sort((a, b) => byKind[b] - byKind[a]);
}

function branchLines(branches: SuiteHealthFixBranch[], limit = MAX_LISTED_BRANCHES): string[] {
    const listed = branches.slice(0, limit);
    const lines = listed.map((branch) => `  · ${label(branch)} - ${detail(branch)}`);

    const hidden = branches.length - listed.length;
    if (hidden > 0) lines.push(`  · + ${hidden} more`);

    return lines;
}

function label(branch: SuiteHealthFixBranch): string {
    if (branch.state === "main") return `${branch.branchName} (main branch)`;
    if (branch.prNumber == null) return branch.branchName;
    return `#${branch.prNumber} ${branch.prTitle ?? branch.branchName}`;
}

function detail(branch: SuiteHealthFixBranch): string {
    const age = branch.oldestAgeDays === 0 ? "today" : `${branch.oldestAgeDays}d`;
    const noun = branch.issueCount === 1 ? "finding" : "findings";

    return `${branch.issueCount} ${noun} (${countByKind(branch)}), ${age}`;
}

/**
 * Tallies EVERY finding on the branch, from `byKind` - never from the `issues` array, which is capped for
 * display. Counting the shown ones produced lines reading "16 findings (4 scenario)".
 */
function countByKind(branch: SuiteHealthFixBranch): string {
    return orderedKinds(branch.byKind)
        .map((kind) => `${branch.byKind[kind]} ${kind}`)
        .join(", ");
}
