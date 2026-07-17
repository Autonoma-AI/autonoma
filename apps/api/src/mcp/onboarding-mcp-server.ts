import { logger as rootLogger } from "@autonoma/logger";
import { type AgentLogEntry, isProtectedPreviewkitEnvKey, previewConfigSchema } from "@autonoma/types";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Services } from "../routes/build-services";
import type { PreviewReadiness } from "../routes/onboarding/preview-readiness";
import type { McpAnalytics } from "./mcp-analytics";
import { describeError, errorResult, jsonResult, toToolResult } from "./tool-result";

/**
 * How many recent log lines get_session_status returns per source. Enough to carry
 * the failing step (e.g. a `pnpm install` error) without flooding a polled tool.
 */
const RECENT_LOG_TAIL_LINES = 30;
const ACTIVITY_DESCRIPTION_MAX_LENGTH = 120;

/**
 * An optional short, human-readable summary an agent attaches to a write. The user
 * watches these on the read-only activity feed, so a legible line ("Set up boss-roast
 * on Node with a Redis cache") reads far better there than the raw tool name + args.
 */
const activityDescription = z
    .string()
    .max(ACTIVITY_DESCRIPTION_MAX_LENGTH)
    .optional()
    .describe("A short human-readable summary of this action, shown to the user on the activity feed.");

/** A short tail of one log stream, attached to get_session_status so a polling agent sees why a deploy failed. */
interface RecentLogTail {
    source: "build" | "app";
    lines: string[];
}

/**
 * Server-level guidance the onboarding MCP client reads on connect. Portable and
 * client-agnostic so a Claude / Cursor / Codex agent configures a preview the
 * same way. The app is pinned by a pairing code the user copies from the UI - the
 * agent never needs a repo name.
 */
const ONBOARDING_INSTRUCTIONS = `Autonoma runs your end-to-end tests against a preview deployment of your app. These tools let a coding agent configure that preview during onboarding: set up the build, databases, services and env, deploy off the main branch, and iterate until it comes up - while the user watches read-only in the Autonoma UI.

Start every session by pairing:
1. The user starts onboarding in the Autonoma UI and clicks "Configure with coding agent". The UI shows a short pairing CODE.
2. Call pair(code) with it. That claims the app's config for you and returns its applicationId and current config. Use that applicationId for every other tool.

Then loop until the preview is up:
3. get_config(applicationId) - read the current preview config.
4. apply_config(applicationId, document) - save the FULL config document (call get_config first, edit it, send the whole thing back). It is validated on save; if invalid, the error tells you what to fix.
5. If the app needs secret env values (third-party API keys, tokens) you do NOT have: call request_env(applicationId, keys). NEVER put secret values in any tool call - you cannot, there is no tool that takes them. The user enters them in the Autonoma UI. ALWAYS ask the user first whether to set env on Autonoma from their .env (the default, they paste it into the UI) or configure them manually. Never request AUTONOMA_* variables (AUTONOMA_PREVIEWKIT, AUTONOMA_PREVIEWKIT_PR, AUTONOMA_PREVIEWKIT_URL, AUTONOMA_SHARED_SECRET, AUTONOMA_SIGNING_SECRET) - Autonoma injects all of them automatically and rejects attempts to set them. Non-secret config (e.g. NODE_ENV) belongs in apply_config as an app connection, and so does the URL of a service that lives INSIDE the preview (its own Postgres, Redis, ...) - that URL only exists at deploy time, so wire it as a connection instead of asking the user for it.
6. trigger_deploy(applicationId) - deploy the main branch (environment 0).
7. get_session_status(applicationId) - poll this for both "is the build done" and "did the user answer my request". It returns the deploy status, the preview URL, diagnostics, and your control state. While a request is pending, do NOT tell the user to come back and confirm here - they answer in the Autonoma UI and may never return to this chat. Keep polling until pendingRequest clears, then continue on your own. When it clears, check lastEnvResolution: the user may have SKIPPED keys they don't have (skippedKeys) - adapt the config to live without them (default, drop, or rework) instead of re-requesting.
8. When status shows the preview is up, verify it yourself: curl the preview URL, or write a small Playwright script if the user has Playwright, and check you get what you expect. If it is broken, read the diagnostics, fix the config, and loop.

Connections wire env vars to the preview's own topology, resolved at deploy time - services do NOT auto-inject anything into apps. If an app needs to reach a database/service declared in this config, you MUST add a connection on that app. The value is a template: {{name.property}} tokens reference apps/services/addons by name. For a service, {{db.url}} is the full canonical connection string (postgres -> postgresql://preview:preview@<host>:<port>/preview) - prefer it; {{db.host}} / {{db.port}} exist for hand-built URLs. For an app, {{api.url}} is its public HTTPS URL. {{pr}}, {{namespace}} and {{owner}} are also available. Example: apps[].connections = [{ "key": "DATABASE_URL", "value": "{{db.url}}" }].

Control: you hold the config while you work; the UI is read-only. If get_session_status (or any write) reports the user took over (standDown / paused), STOP configuring and let them - do not fight for control. They can hand it back with "Resume with Claude" and you re-claim on your next call. If you go idle for a while the UI hands control back automatically; just resume when the user asks.`;

/** Everything the onboarding MCP tools need: the service graph and the authenticated user. */
export interface OnboardingMcpDeps {
    services: Services;
    /** The OAuth-authenticated user driving the agent (from the verified MCP token). */
    userId: string;
    /** Records a `mcp.tool_called` PostHog event per tool invocation, attributed to the resolved org. */
    analytics: McpAnalytics;
}

/** Identifies a single guarded write for the mutex claim and the activity stream. */
interface GuardedWriteParams {
    applicationId: string;
    /** The MCP tool name, used as the log-entry label and in failure logs. */
    tool: string;
    /** Human-readable description shown on the "running" activity row in the UI. */
    message: string;
    /** Rendered as dim JSON on the activity row; never carries secret values. */
    toolArguments?: AgentLogEntry["toolArguments"];
}

/** The result a write tool returns when the human has taken over - the agent must stand down. */
function pausedResult(): CallToolResult {
    return jsonResult({
        status: "paused",
        standDown: true,
        message:
            "The user took over configuration in the Autonoma UI. Stop configuring and let them continue. " +
            "They can hand control back with 'Resume with Claude', after which your next call re-claims it.",
    });
}

/**
 * Builds the "onboarding" MCP server: the client-facing toolset a coding agent
 * uses to configure a PreviewKit preview during onboarding. The app is pinned by
 * a pairing code (not a repo name); every tool resolves the org from the
 * per-call `applicationId` and verifies the authenticated user's membership.
 * Writes go through the {@link OnboardingAgentSessionService} soft mutex so the
 * UI can watch read-only and take over. Secret VALUES never pass through any tool.
 */
export function buildOnboardingMcpServer(deps: OnboardingMcpDeps): McpServer {
    const logger = rootLogger.child({ name: "onboardingMcpServer" });
    const { services, userId, analytics } = deps;
    const session = services.onboardingAgentSession;

    const server = new McpServer(
        { name: "autonoma-onboarding", version: "0.1.0" },
        { instructions: ONBOARDING_INSTRUCTIONS },
    );

    /**
     * Resolve the org from a tool's `applicationId` (verifying the user's
     * membership) and bind it to the analytics scope, so each tool's
     * `mcp.tool_called` event is attributed to the customer org. Use this in every
     * tool instead of calling the service directly.
     */
    const resolveOrg = analytics.observeOrgResolution((applicationId) =>
        session.resolveOrgForMember(applicationId, userId),
    );

    /**
     * The recent log tail attached to get_session_status so a polling agent can see
     * WHY a deploy failed and fix it, instead of looping blindly on a phase string.
     * A failed build (a broken `pnpm install`, a bad Dockerfile) lives in build logs;
     * a container that built then crashed lives in app logs. So while building we show
     * build, when up we show app, and on failure we return both - the failure could be
     * either, and the agent needs whichever line actually carries the error.
     * Best-effort: a log-tail failure (Loki unset or down) never fails the poll.
     */
    async function tailPhaseLogs(
        organizationId: string,
        diagnostics: PreviewReadiness["diagnostics"],
    ): Promise<RecentLogTail[]> {
        const { logs, status } = diagnostics;
        if (!logs.available) return [];

        const sources: Array<"build" | "app"> =
            status === "ready" ? ["app"] : status === "failed" ? ["build", "app"] : ["build"];
        const tails = await Promise.all(
            sources.map(async (source): Promise<RecentLogTail | undefined> => {
                try {
                    const tail = await services.previewkitLogs.tail({
                        repoFullName: logs.repoFullName,
                        prNumber: logs.prNumber,
                        source,
                        callerOrgId: organizationId,
                        limit: RECENT_LOG_TAIL_LINES,
                        from: "tail",
                    });
                    if (tail == null || !tail.available || tail.lines.length === 0) return undefined;
                    return { source, lines: tail.lines.map((line) => line.message) };
                } catch (err) {
                    logger.warn("get_session_status recent-log tail failed", { extra: { source }, err });
                    return undefined;
                }
            }),
        );
        return tails.filter((tail): tail is RecentLogTail => tail != null);
    }

    /**
     * Best-effort: record which coding agent is driving from the MCP `clientInfo`
     * handshake, so the UI can name it ("Cursor is configuring...") instead of
     * assuming one. Undefined when the client did not report it (or the handshake
     * isn't on this request) - the UI then shows a neutral label. Never throws.
     */
    async function captureAgentClient(applicationId: string): Promise<void> {
        const name = server.server.getClientVersion()?.name;
        if (name == null || name.length === 0) return;
        try {
            await session.recordAgentClient(applicationId, name);
        } catch (err) {
            logger.warn("recordAgentClient failed", { applicationId, err });
        }
    }

    /**
     * Runs one agent write under the config mutex, streaming it as an activity
     * entry and recording an `mcp.tool_called` event. The steps are a deliberate
     * gated sequence, not parallelizable: authorize membership first (so a
     * non-member never mutates), then claim the mutex (standing down if the human
     * took over), then log-run-finish the work. Generic over the work's result so
     * the tool's payload stays fully typed.
     */
    async function guardedWrite<T>(
        { applicationId, tool, message, toolArguments }: GuardedWriteParams,
        work: (organizationId: string) => Promise<T>,
    ): Promise<CallToolResult> {
        return analytics.track(tool, async () => {
            try {
                const organizationId = await resolveOrg(applicationId);
                const claim = await session.claimForAgent(applicationId);
                if (!claim.claimed) return pausedResult();

                const eventId = await session.startLogEntry(applicationId, tool, message, toolArguments);
                try {
                    const result = await work(organizationId);
                    await session.finishLogEntry(applicationId, eventId, "done");
                    return jsonResult(result);
                } catch (err) {
                    await session.finishLogEntry(applicationId, eventId, "error", describeError(err));
                    throw err;
                }
            } catch (err) {
                logger.warn(`${tool} failed`, { applicationId, err });
                return toToolResult(err);
            }
        });
    }

    server.registerTool(
        "pair",
        {
            title: "Pair with an app",
            description:
                "Claim an app's preview config using the pairing code the user copied from the Autonoma UI. " +
                "Returns the applicationId (use it for every other tool) and the current config.",
            inputSchema: { code: z.string().min(1) },
        },
        async ({ code }) =>
            analytics.track("pair", async () => {
                try {
                    logger.info("Pairing agent with code");
                    const view = await session.pairAgent(code, userId);
                    await captureAgentClient(view.applicationId);
                    const organizationId = await resolveOrg(view.applicationId);
                    const config = await services.onboarding.getPreviewkitConfig(view.applicationId, organizationId);
                    return jsonResult({
                        paired: true,
                        applicationId: view.applicationId,
                        currentConfig: config.document,
                        configExists: config.saved,
                    });
                } catch (err) {
                    logger.warn("pair failed", { err });
                    return toToolResult(err);
                }
            }),
    );

    server.registerTool(
        "get_config",
        {
            title: "Read the preview config",
            description: "Read the current PreviewKit config document for an app.",
            inputSchema: { applicationId: z.string() },
        },
        async ({ applicationId }) =>
            analytics.track("get_config", async () => {
                try {
                    const organizationId = await resolveOrg(applicationId);
                    const config = await services.onboarding.getPreviewkitConfig(applicationId, organizationId);
                    return jsonResult({ document: config.document, configExists: config.saved });
                } catch (err) {
                    logger.warn("get_config failed", { applicationId, err });
                    return toToolResult(err);
                }
            }),
    );

    server.registerTool(
        "apply_config",
        {
            title: "Save the preview config",
            description:
                "Save the FULL PreviewKit config document (read it with get_config first, edit it, send the whole " +
                "document back). Validated on save; an invalid document returns the errors to fix. Never include " +
                "secret values - declare secret keys as build_secrets and set their values via request_env. " +
                "Services do not auto-inject env into apps: wire each app to the databases/services it uses via " +
                "connections, e.g. { key: 'DATABASE_URL', value: '{{db.url}}' } ({{name.property}} tokens resolve " +
                "at deploy time; {{service.url}} is the full connection string). " +
                "Pass a short `description` of what this save does - the user watches it on the activity feed.",
            inputSchema: {
                applicationId: z.string(),
                document: previewConfigSchema,
                description: activityDescription,
            },
        },
        async ({ applicationId, document, description }) =>
            guardedWrite(
                {
                    applicationId,
                    tool: "apply_config",
                    message: description ?? "Saving preview config",
                    toolArguments: { apps: document.apps.length },
                },
                (org) => services.onboarding.savePreviewkitConfig(applicationId, org, document),
            ),
    );

    server.registerTool(
        "request_env",
        {
            title: "Ask the user for env values",
            description:
                "Ask the user to enter secret env VALUES in the Autonoma UI (you never see them). Pass only the KEYS " +
                "you need and the appName they belong to (secret stores are per-app; read it from get_config). ALWAYS " +
                "ask the user first whether to fill from their .env (default) or set them manually. Then poll " +
                "get_session_status until the pending request clears - the user answers in the Autonoma UI, so never " +
                "ask them to come back here and confirm. AUTONOMA_* variables are injected automatically and are " +
                "rejected. Pass a short `description` of what you're requesting and why - the user watches it on " +
                "the activity feed.",
            inputSchema: {
                applicationId: z.string(),
                keys: z.array(z.string().min(1)).min(1),
                appName: z.string().min(1),
                note: z.string().optional(),
                description: activityDescription,
            },
        },
        async ({ applicationId, keys, appName, note, description }) => {
            // Reject Autonoma-provided keys BEFORE raising the request: the UI's value
            // submission hard-rejects them, so a request containing one is unanswerable -
            // the user would be stuck staring at a form they can never satisfy. Failing
            // here instead lets the agent drop the keys and re-request only what's real.
            const protectedKeys = keys.filter(isProtectedPreviewkitEnvKey);
            if (protectedKeys.length > 0) {
                return errorResult(
                    `Refusing to request ${protectedKeys.join(", ")}: Autonoma injects these automatically into ` +
                        "every preview app and the user cannot set them. Remove them and request only the app's " +
                        "own secrets (third-party API keys, tokens). A preview-internal service URL is not a user " +
                        "secret either - wire it as a connection in apply_config.",
                );
            }
            return guardedWrite(
                {
                    applicationId,
                    tool: "request_env",
                    message: description ?? `Requesting ${keys.length} env value(s) from the user`,
                    toolArguments: { keys, appName },
                },
                async () => {
                    await session.raisePendingRequest(applicationId, { kind: "env", keys, appName, note });
                    return {
                        status: "input_requested",
                        message:
                            "Asked the user to provide these values in the Autonoma UI. Poll get_session_status; " +
                            "when pendingRequest is cleared they are set. The user can SKIP keys they don't have - " +
                            "check lastEnvResolution.skippedKeys and adapt the config (default it, drop it, or " +
                            "rework the approach) instead of re-requesting the same key. Do NOT ask for or send " +
                            "the values yourself, and do NOT tell the user to come back here and confirm - they " +
                            "answer in the UI. Continue on your own once the request clears.",
                    };
                },
            );
        },
    );

    server.registerTool(
        "trigger_deploy",
        {
            title: "Deploy the preview",
            description:
                "Deploy the app's main branch as the preview (environment 0), applying the saved config. Then poll " +
                "get_session_status until it is up, and verify the preview URL yourself. " +
                "Pass a short `description` of what you are deploying - the user watches it on the activity feed.",
            inputSchema: { applicationId: z.string(), description: activityDescription },
        },
        async ({ applicationId, description }) =>
            guardedWrite(
                {
                    applicationId,
                    tool: "trigger_deploy",
                    message: description ?? "Deploying preview (main branch)",
                    toolArguments: {},
                },
                (org) => services.onboarding.triggerPreviewkitMainDeploy(applicationId, org),
            ),
    );

    server.registerTool(
        "get_session_status",
        {
            title: "Poll status",
            description:
                "The single polling tool: returns your control state, any pending user request, the deploy status, " +
                "the preview URL, diagnostics, and `recentLogs` - a tail of the build logs while building (or both " +
                "build and app logs on failure) so you can see WHY a deploy failed and fix it, not just that it did. " +
                "Poll this to wait for a build to finish AND to wait for the user to answer a request. When an env " +
                "request resolves, `lastEnvResolution` tells you which keys were set and which the user SKIPPED " +
                "(doesn't have) - adapt to skipped keys instead of re-requesting them. When diagnostics.status is " +
                "`failed`, read recentLogs for the failing step, fix the config or ask the user for a missing " +
                "secret, then redeploy. If it reports standDown, the user took over - stop configuring.",
            inputSchema: { applicationId: z.string() },
        },
        async ({ applicationId }) =>
            analytics.track("get_session_status", async () => {
                try {
                    const organizationId = await resolveOrg(applicationId);
                    // Capture the client on a polled call too, in case the pair request
                    // didn't carry the handshake. No-op once the client is already known.
                    await captureAgentClient(applicationId);
                    // Beat the heartbeat first so the freshly-read view reflects it, then
                    // fetch the view and the deploy readiness together - independent reads.
                    await session.heartbeatIfAgentHeld(applicationId);
                    const [view, readiness] = await Promise.all([
                        session.getForUi(applicationId),
                        services.onboarding.getPreviewReadiness(applicationId, organizationId),
                    ]);
                    // Needs readiness.diagnostics (status + the log-stream handle), so it
                    // can't join the parallel read above.
                    const recentLogs = await tailPhaseLogs(organizationId, readiness.diagnostics);
                    return jsonResult({
                        standDown: view?.holder === "human",
                        holder: view?.holder,
                        pendingRequest: view?.pendingRequest,
                        lastEnvResolution: view?.lastEnvResolution,
                        previewVerificationStatus: view?.previewVerificationStatus,
                        step: view?.step,
                        previewUrl: readiness.previewUrl,
                        diagnostics: readiness.diagnostics,
                        recentLogs,
                    });
                } catch (err) {
                    logger.warn("get_session_status failed", { applicationId, err });
                    return toToolResult(err);
                }
            }),
    );

    return server;
}
