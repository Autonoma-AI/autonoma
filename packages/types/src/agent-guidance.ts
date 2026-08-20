/**
 * What a coding agent needs to be told about Autonoma, in the words every surface uses.
 *
 * Both the MCP server's connect-time instructions and the pull request's fix prompt read these, and they must
 * not drift - an agent handed a prompt out of a browser has no server instructions to fall back on, so the
 * routing rules have to travel inside the prompt itself.
 */

import { analysisIssueKindSchema, type AnalysisIssueKind } from "./schemas/analysis";

export const AUTONOMA_ELEVATOR_PITCH =
    "Autonoma runs your end-to-end tests against a per-PR preview deployment of your app and reviews the result.";

export const AUTONOMA_MCP_URL = "https://api.autonoma.app/v1/mcp";
export const AUTONOMA_MCP_SERVER_NAME = "autonoma";

export const ISSUE_KIND_FIX_GUIDANCE: Record<AnalysisIssueKind, string> = {
    bug: "the app misbehaved. Fix it in this repo and push.",
    environment:
        "the preview could not run properly (a missing secret, a broken service). Fix it with the Autonoma MCP's deploy tools - get_secret_status / set_secret / edit_previewkit_config - no repo change needed.",
    scenario:
        "the test data was missing or wrong. Fix it with the Autonoma MCP's recipe tools - list_scenarios / get_recipe / dry_run_scenario - which take effect with no redeploy.",
};

/**
 * The routing rules as a bulleted block. Pass only the kinds actually in front of the reader: listing
 * `environment` when none was selected sends the agent to `diagnose_deploy` for nothing.
 */
export function describeIssueKindRouting(kinds: readonly AnalysisIssueKind[] = ALL_ISSUE_KINDS): string {
    const present = ALL_ISSUE_KINDS.filter((kind) => kinds.includes(kind));
    return present.map((kind) => `- ${kind}: ${ISSUE_KIND_FIX_GUIDANCE[kind]}`).join("\n");
}

export const FALSE_POSITIVE_GUIDANCE =
    "A fourth outcome has no fix in this repo: the issue is not real, or the run went wrong for a reason no future run should repeat. When you conclude an issue is a FALSE POSITIVE - the behavior it flagged is intended - say so where the next run will read it: get_app_instructions(repoFullName), then update_app_instructions with that point merged into testScopeGuidelines. Use customInstructions the same way for a quirk of the app the agent has to know to get through a flow. Both are the user's settings text, so merge into what is there and pass the fingerprint you read; do not replace it wholesale. Only record what will still be true next month - not a note about the PR in front of you.";

export function describeRecheckLoop(target?: { repoFullName?: string; prNumber: number }): string {
    const call =
        target != null ? `start_analysis(${renderTargetArgs(target)})` : "start_analysis(repoFullName, prNumber)";
    return `When you have fixed the cause and pushed, call ${call} to ask Autonoma to re-check the PR against its preview - so you can confirm the fix from here without switching to GitHub to comment ${MERGE_GATE_START_COMMAND}. It no-ops quietly if the gate/activation is not enabled for the org; poll get_analysis afterward for the new verdict.`;
}

/**
 * How to read these issues live through the MCP, for an agent that may not have it connected.
 *
 * `--scope user` matters: the default (`local`) binds the server to whatever directory the command ran in, and
 * the tools then appear to be missing. The agent is told not to install it itself because the install needs a
 * browser login it does not have.
 */
export function buildAutonomaMcpHint(target: { repoFullName?: string; prNumber: number }): string {
    return [
        `Connect the Autonoma MCP, then call \`get_analysis(${renderTargetArgs(target)})\` to read these issues and their evidence live - fresher than anything pasted here, with re-signed screenshot URLs. It also exposes this PR's deploy status and build/app logs.`,
        `If it is not connected, do not install it yourself: ask the user to run \`claude mcp add --transport http --scope user ${AUTONOMA_MCP_SERVER_NAME} ${AUTONOMA_MCP_URL}\` then \`claude mcp login ${AUTONOMA_MCP_SERVER_NAME}\` in their own terminal (or use their client's MCP config), and tell them to restart you afterwards - a running session does not pick up a server added or signed in underneath it. Without a browser, send an Autonoma API key as \`Authorization: Bearer <key>\` instead.`,
    ].join(" ");
}

const MERGE_GATE_START_COMMAND = "/start analysis";

const ALL_ISSUE_KINDS: readonly AnalysisIssueKind[] = analysisIssueKindSchema.options;

function renderTargetArgs(target: { repoFullName?: string; prNumber: number }): string {
    const repo = target.repoFullName ?? "owner/repo";
    return `repoFullName="${repo}", prNumber=${target.prNumber}`;
}
