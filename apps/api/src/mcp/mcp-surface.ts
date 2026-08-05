import { DEBUG_INSTRUCTIONS } from "./debug-tools";
import { ONBOARDING_INSTRUCTIONS } from "./onboarding-tools";

/**
 * The paths the MCP surface answers on. `mcp` is the one address to give out; `debug` and
 * `onboarding` are the addresses people already have in their client configuration and keep
 * working forever. All three serve the same tools - what differs is the guidance a client reads
 * on connect, and the name each call is attributed to in analytics.
 */
export type McpSurface = "mcp" | "debug" | "onboarding";

/**
 * How an agent tells the two jobs apart on the one server that offers both.
 *
 * The two halves were written as if each were the whole world - one opens "start with the
 * analysis", the other "start every session by pairing" - so handing an agent both back to back
 * gives it two contradictory first moves. This is the router that goes in front: it names the
 * question whose answer picks a half (is this app already set up?) and the signal that answers it
 * (a pairing code the user read off the Autonoma UI), so the agent commits to one before it
 * reads either.
 */
const SURFACE_ROUTER = `This server carries both of Autonoma's jobs. They are separate pieces of work with separate entry points, so decide which one you are doing before you call anything.

- **SETTING AN APP UP** (onboarding): the user is in the Autonoma UI clicking "Configure with coding agent" and has a short PAIRING CODE for you. That code is the giveaway - if the user gave you one, this is the job. Start with pair(code) as your very first action, then follow the playbook it returns. Read "Setting up an app" below.
- **FIXING A PULL REQUEST** (debugging): Autonoma has already reviewed a pull request and flagged something, or a preview failed to build or deploy. There is no pairing code; you name the app by its GitHub repo ("owner/repo", normally this checkout's remote). Start with get_analysis(repoFullName, prNumber). Read "Debugging a reviewed pull request" below.

If neither fits - the user just wants to know what Autonoma sees for a repo - use the debugging tools; they read live state and change nothing.

Some tools serve both jobs and take either identity - you can tell which from the input schema, since they accept both \`applicationId\` (from pair) and \`repoFullName\` and require exactly one. Pass whichever you have; it is the same tool either way.

One thing carries across both jobs: while an agent is driving an app's onboarding, the user is watching a read-only config screen in the Autonoma UI. Writes against such an app take a soft mutex and appear on that screen as they run, and a write can come back \`standDown: true\` when the user takes over - stop configuring when it does. On an app nobody is configuring there is no mutex and nothing to watch, and the same tools just run.`;

/**
 * Connect-time guidance for the merged surface: the router above, then each job's own
 * instructions verbatim, so an agent that has picked a job reads exactly what it would have read
 * on that job's own mount.
 */
const MERGED_INSTRUCTIONS = `${SURFACE_ROUTER}

# Setting up an app

${ONBOARDING_INSTRUCTIONS}

# Debugging a reviewed pull request

${DEBUG_INSTRUCTIONS}`;

/** What a client reads on connect, and the server name it sees. */
export interface SurfaceGuidance {
    name: string;
    instructions: string;
}

/**
 * Told to an agent that connected on the debug address. It keeps the debugging guidance it has
 * always had as its whole first read, so an agent that arrived here to fix a pull request is not
 * handed an onboarding playbook it has no use for - but the onboarding tools ARE in its tool list,
 * and silently unexplained tools are worse than named ones.
 *
 * It names the other job's ENTRY POINT and nothing else. Listing that job's tools here would be a
 * second copy of the tool registrations, kept in prose, that nothing checks - and a note that
 * confidently names a tool the server no longer has is worse than one that names none.
 */
const DEBUG_ALIAS_NOTE = `This address is an alias for /v1/mcp - the same server - so your tool list also carries Autonoma's ONBOARDING tools. Those are for setting an app up on Autonoma for the first time, and that job starts from a short PAIRING CODE the user copies out of the Autonoma UI and hands to you: with a code, call pair(code) and follow the playbook it returns. Without one, that is not the job you are doing - ignore them and use the tools above. Nothing about the debugging tools has changed, and this address is not going away.`;

/**
 * The same note from the onboarding side, and on the same terms - the entry point, not a listing.
 * Onboarding legitimately runs into debugging territory (the preview that will not come up, the
 * SDK handler throwing on a PR preview), so this one is more of an invitation than a warning.
 */
const ONBOARDING_ALIAS_NOTE = `This address is an alias for /v1/mcp - the same server - so your tool list also carries Autonoma's pull-request DEBUGGING tools. They apply to an app that is already LIVE and being reviewed, and they are keyed by the GitHub repo ("owner/repo") rather than by the applicationId pair returned; get_analysis(repoFullName, prNumber) is where that job starts. During onboarding you rarely need them - get_session_status and get_target_logs cover the previews you are working on - but once the app is live they are how you read what Autonoma found on a pull request. Nothing about the onboarding tools has changed, and this address is not going away.`;

/** The guidance and server name for one address. */
export function surfaceGuidance(surface: McpSurface): SurfaceGuidance {
    if (surface === "debug") {
        return { name: "autonoma-debug", instructions: `${DEBUG_INSTRUCTIONS}\n\n${DEBUG_ALIAS_NOTE}` };
    }
    if (surface === "onboarding") {
        return { name: "autonoma-onboarding", instructions: `${ONBOARDING_INSTRUCTIONS}\n\n${ONBOARDING_ALIAS_NOTE}` };
    }
    return { name: "autonoma", instructions: MERGED_INSTRUCTIONS };
}
