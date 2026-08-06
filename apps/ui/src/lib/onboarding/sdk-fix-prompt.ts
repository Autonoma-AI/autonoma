import { capHandoffPrompt, sdkErrorStatus } from "@autonoma/types";
import { ENVIRONMENT_FACTORY_GUIDE_URL, FRAMEWORK_EXAMPLE_URL } from "./sdk-docs-links";

/** The fixed convention the environment factory is mounted at. */
const SDK_ROUTE = "/api/autonoma";

export interface SdkFixPromptInput {
    /** The application as the user named it, so the agent can tell which repo it is sitting in. */
    applicationName: string;
    /** Both MCP tools below take one - and neither accepts a repo name - so the brief has to carry it. */
    applicationId: string;
    /** The dry-run target id `validate_sdk` and `get_target_logs` name the preview by. */
    targetId?: string;
    /** The failure, verbatim - it is the whole evidence, and paraphrasing it loses the status code. */
    error: string;
    /** The endpoint Autonoma called. Absent when the target has not deployed far enough to have one. */
    sdkUrl?: string;
    /** The preview the endpoint is served from. */
    previewUrl?: string;
    /** How the target reads in the picker, e.g. "feat: autonoma-sdk #42" or "Preview - feat/autonoma-sdk". */
    targetLabel?: string;
    /** The pull request the preview was built from, when there is one. */
    pullRequestUrl?: string;
    /**
     * Set only for an Autonoma-managed preview. It doubles as the test for whether Autonoma holds
     * this preview's runtime logs - `get_target_logs` refuses any target it does not operate, so
     * offering it for a Vercel or bring-your-own deployment would send the agent to a dead end.
     */
    repoFullName?: string;
    /** The Autonoma MCP endpoint, from `mcpEndpointUrl()`. */
    mcpUrl: string;
    /** The MCP server's registered name - the prompt must say it literally. */
    mcpServerName: string;
}

/**
 * The paste-ready brief for a coding agent, for an SDK validation that failed on the user's own
 * code.
 *
 * Written to stand alone: the agent gets the failure, the endpoint, the contract it was supposed to
 * satisfy, and how to reach Autonoma live - because the in-app page it came from needs a login the
 * agent does not have. Same shape as the brief the pull-request comment hands over, so an agent
 * that has fixed a finding recognizes this one.
 */
export function buildSdkFixPrompt(input: SdkFixPromptInput): string {
    const sections = [
        buildHeader(input),
        buildLikelyCauseSection(input.error),
        buildWhereSection(input),
        buildContractSection(),
        buildMcpSection(input),
        `Docs: environment factory guide ${ENVIRONMENT_FACTORY_GUIDE_URL} - framework example ${FRAMEWORK_EXAMPLE_URL}`,
    ].filter((section) => section !== undefined);

    return capHandoffPrompt(sections.join("\n\n"), ENVIRONMENT_FACTORY_GUIDE_URL);
}

function buildHeader(input: SdkFixPromptInput): string {
    const endpoint = input.sdkUrl != null ? ` at ${input.sdkUrl}` : "";
    return [
        `Fix the Autonoma SDK endpoint (the environment factory) in this repo - it is the app "${input.applicationName}".`,
        `Autonoma called \`discover\` on it${endpoint} and the call failed:`,
        `    ${input.error}`,
        "Find the cause in this repo, fix it, and re-validate. Do not change anything in Autonoma to work around it.",
    ].join("\n\n");
}

/**
 * What the status code actually means for this handler, spelled out.
 *
 * The status alone is the part an agent is most likely to misread. "404" reads as a routing
 * mistake, but the overwhelmingly common cause is a handler that IS mounted and is refusing to
 * answer, because it is gated on `NODE_ENV` - and a preview deployment is a production build. An
 * agent told only "it 404s" goes looking for the route; an agent told what the 404 means goes
 * looking for the guard. Everything here is the failure mode, never a change to make in Autonoma.
 */
function buildLikelyCauseSection(error: string): string | undefined {
    const cause = describeLikelyCause(sdkErrorStatus(error));
    if (cause == null) return undefined;
    return ["## What this failure usually means", cause].join("\n\n");
}

function describeLikelyCause(status: number | undefined): string | undefined {
    if (status === 404) {
        return [
            `Nothing served \`${SDK_ROUTE}\` on this deployment. Two ways that happens, and the second is far more common:`,
            `1. The handler is not mounted on this build at all - the branch this preview was built from does not have the route, or it is mounted at a different path. Autonoma only ever calls \`${SDK_ROUTE}\`.`,
            "2. The handler IS mounted, and is deliberately refusing to answer. A factory that can create and delete data is usually guarded so it cannot run in production, and the guard is normally written against `NODE_ENV` - but a preview deployment is a production build, so `NODE_ENV` is `production` there too, and the guard disables the endpoint on exactly the deployments Autonoma tests. An error mentioning production, a disabled endpoint, or a development-only route is this case.",
            "For (2), do not simply remove the guard - gate it on something that is true on a preview and false in your real production environment. The presence of `AUTONOMA_SHARED_SECRET` works, since Autonoma injects it only into the environments it drives; a dedicated flag you set per-environment works too. Keep the endpoint off in production.",
        ].join("\n\n");
    }
    if (status === 401 || status === 403) {
        return [
            "The handler received the request and rejected its credentials. Autonoma authorizes with `AUTONOMA_SHARED_SECRET` and signs the request body with `AUTONOMA_SIGNING_SECRET`, both injected into this deployment. The usual causes:",
            "- The handler compares against a value from somewhere else - hardcoded, or another environment's secret - instead of reading it from the environment of the deployment it is running on.",
            "- The HMAC is computed over a re-serialized body (a parsed-then-stringified JSON object) rather than the raw request bytes, so it never matches.",
            "- Something in front of the app - a deployment-protection gate, an auth middleware, a proxy - answered before the handler did.",
        ].join("\n");
    }
    if (status === 400 || status === 422) {
        return "The handler received the request and rejected its contents. For `discover` this is almost always the factory registry: a model Autonoma asked about has no factory registered, or the schema the handler returned does not match the shape the SDK expects. The error text names the model or field it rejected - start there.";
    }
    if (status != null && status >= 500) {
        return "The handler threw. This is an exception inside your own code, not a contract mismatch - the error text is whatever your framework surfaced, which is often generic. The stack trace behind it is in the deployment's runtime logs.";
    }
    return undefined;
}

function buildWhereSection(input: SdkFixPromptInput): string | undefined {
    const lines: string[] = [];
    if (input.targetLabel != null) lines.push(`- Validation target: ${input.targetLabel}`);
    if (input.previewUrl != null) lines.push(`- Preview: ${input.previewUrl}`);
    if (input.pullRequestUrl != null) lines.push(`- Pull request: ${input.pullRequestUrl}`);
    if (lines.length === 0) return undefined;
    return ["## Where it failed", ...lines].join("\n");
}

function buildContractSection(): string {
    return [
        "## What the endpoint has to do",
        `- One POST route at \`${SDK_ROUTE}\`, serving three actions: \`discover\` (return the schema of the models it can seed), \`up\` (create a scenario's test data), \`down\` (tear it down). \`discover\` is the one failing here.`,
        "- It must answer on the preview deployment. Previews are production builds, so any guard that keeps the factory out of production has to be written so it still lets previews through.",
        "- Autonoma provisions `AUTONOMA_SHARED_SECRET` (authorizes the request) and `AUTONOMA_SIGNING_SECRET` (HMAC-signs the body) into the deployment for you; read both from the environment in the handler rather than hardcoding or re-deriving them.",
    ].join("\n");
}

function buildMcpSection(input: SdkFixPromptInput): string {
    // Both tools take an applicationId and a target id, and neither accepts a repo name, so the
    // brief spells the arguments out - an agent that has to go looking for them guesses instead.
    const target = input.targetId != null ? `, target: "${input.targetId}"` : "";
    const logs =
        input.repoFullName != null
            ? `\`get_target_logs(applicationId: "${input.applicationId}"${target}, source: "app")\` returns this preview's runtime output - the handler's own stack trace behind the error above lives there.`
            : "Autonoma does not host this preview, so read its runtime logs wherever the deployment runs; the stack trace behind the error above is there.";
    return [
        "## Reading the failure live",
        // Name the server literally: an agent holding several MCPs cannot resolve a prompt that
        // names none of them, and picks one at random.
        `Connect the \`${input.mcpServerName}\` MCP. Then \`validate_sdk(applicationId: "${input.applicationId}"${target})\` re-runs this exact validation after each change, and \`list_dry_run_targets(applicationId: "${input.applicationId}")\` lists the previews if you need a different one. ${logs}`,
        // `--scope user` matters: the default (`local`) binds the server to whatever directory the
        // command ran in, and the tools then appear to be missing.
        `If it is not connected, do not install it yourself: ask the user to run \`claude mcp add --transport http --scope user ${input.mcpServerName} ${input.mcpUrl}\` then \`claude mcp login ${input.mcpServerName}\` in their own terminal (or use their client's MCP config), and tell them to restart you afterwards - a running session does not pick up a server added or signed in underneath it.`,
    ].join("\n\n");
}
