import { logger as rootLogger } from "@autonoma/logger";
import {
    type AgentLogEntry,
    isProtectedPreviewkitEnvKey,
    previewConfigSchema,
    ScenarioRecipeSchema,
} from "@autonoma/types";
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
const ONBOARDING_INSTRUCTIONS = `Autonoma runs your end-to-end tests against a preview deployment of your app. These tools let a coding agent configure that preview during onboarding: set up the build, databases, services and env, deploy off the default branch (or a branch you choose), and iterate until it comes up - while the user watches read-only in the Autonoma UI.

Start every session by pairing - and pair FIRST, before you analyze the repo, read files, or plan. Pairing is low-risk: it only claims the app's config so the UI can show you are connected, it changes NO code and deploys NOTHING, and the user can take over at any time. This matters because the user is watching the Autonoma UI live and sees no activity at all until you pair - pairing is what flips the UI into "your agent is connected and configuring" and starts streaming what you do as feedback. If you spend minutes inspecting the project before pairing, the user just stares at an idle screen with no idea anything is happening (and may give up). So do NOT front-load repo analysis; pair immediately, then investigate.
1. The user starts onboarding in the Autonoma UI and clicks "Configure with coding agent". The UI shows a short pairing CODE.
2. Call pair(code) with it IMMEDIATELY, as your very first action - then do any repo analysis you need. That claims the app's config for you and returns its applicationId and current config. Use that applicationId for every other tool.

Then loop until the preview is up:
3. get_config(applicationId) - read the current preview config.
4. apply_config(applicationId, document) - save the FULL config document (call get_config first, edit it, send the whole thing back). It is validated on save; if invalid, the error tells you what to fix.
5. If the app needs secret env values (third-party API keys, tokens) you do NOT have: call request_env(applicationId, keys). NEVER put secret values in any tool call - you cannot, there is no tool that takes them. The user enters them in the Autonoma UI. ALWAYS ask the user first whether to set env on Autonoma from their .env (the default, they paste it into the UI) or configure them manually. Never request AUTONOMA_* variables (AUTONOMA_PREVIEWKIT, AUTONOMA_PREVIEWKIT_PR, AUTONOMA_PREVIEWKIT_URL, AUTONOMA_SHARED_SECRET, AUTONOMA_SIGNING_SECRET) - Autonoma injects all of them automatically and rejects attempts to set them. Non-secret config (e.g. NODE_ENV) belongs in apply_config as an app connection, and so does the URL of a service that lives INSIDE the preview (its own Postgres, Redis, ...) - that URL only exists at deploy time, so wire it as a connection instead of asking the user for it.
6. trigger_deploy(applicationId) - deploy the base preview environment (environment 0). It deploys the app's configured deploy branch. Pick that branch deliberately rather than defaulting to a name: if unset it uses the repo's default branch (whatever it is named), which is the right choice when the user is working on it. But you typically run from the user's local checkout, which may sit on a different branch - check it (e.g. \`git rev-parse --abbrev-ref HEAD\`). If it is NOT the repo default (e.g. a branch they made to integrate Autonoma), ASK the user whether to deploy that branch or the default, then set their answer with apply_config's \`branch\` field (that does NOT deploy on its own) before trigger_deploy. Do not steer toward any particular branch without cause.
7. get_session_status(applicationId) - poll this for both "is the build done" and "did the user answer my request". It returns the deploy status, the preview URL, diagnostics, and your control state. While a request is pending, do NOT tell the user to come back and confirm here - they answer in the Autonoma UI and may never return to this chat. Keep polling until pendingRequest clears, then continue on your own. When it clears, check lastEnvResolution: the user may have SKIPPED keys they don't have (skippedKeys) - adapt the config to live without them (default, drop, or rework) instead of re-requesting.
8. A ready status only means the pod health check passes - it does NOT mean the app works. Before declaring the preview done, verify it yourself: exercise the main flow against the preview URL (curl it, or a small Playwright script if the user has Playwright - log in, load data, hit a few real routes), then call get_session_status again and READ the app's runtime logs in recentLogs. If the logs show the app erroring behind the healthy page (crashed queries, missing env, stack traces), fix the cause and redeploy. If you cannot exercise the flow yourself, ask the user to click through the app once and then read the logs.

Scenario recipes (test data): a scenario is a named app state a test depends on (e.g. "logged-in admin with one open invoice"); its recipe is the JSON your deployed Autonoma SDK follows to create those entities in the app's OWN database at test time. Before onboarding finishes the recipe often does not work yet, so fix it here: list_scenarios(applicationId) shows the app's scenarios and which already have a recipe; get_recipe(scenarioId) reads one; update_recipe(scenarioId, recipe) saves a corrected version (the recipe's \`name\` must stay the scenario's name - this EDITS an existing scenario, it does not create one; the recipe shape is validated on save and an invalid one is rejected with the exact bad field paths, so read them and resend); dry_run_scenario(scenarioId) runs the recipe end-to-end against the deployed app (calls the SDK \`up\` to create the entities, then \`down\` to tear them back down) and, on failure, returns which phase failed (up/down) and the SDK's error. This needs the app deployed with its SDK URL + signing secret configured, so get the preview up first. A scaled-to-zero preview 503s on the first call while it wakes; dry_run_scenario rides through that warm-up automatically, so give the first run ~a minute before concluding anything is wrong (and if it still comes back with a cold-start/503, just call it again - it is waking).

How to iterate on a failing recipe - first tell apart the TWO things that can be wrong, because they iterate very differently. (1) The recipe JSON (a bad \`create\` graph, a wrong field, an unresolved \`{{variable}}\`): fix it with update_recipe and dry_run_scenario again immediately - the recipe lives on Autonoma, so a change takes effect with NO redeploy. (2) The app's SDK handler code that interprets the recipe and writes to the database (a missing factory for a model, a broken insert): that lives in the app's repo and only changes when the app is REBUILT. So commit the fix and push it to the deploy branch - get_config / pair return \`deployBranch\`, push to THAT branch (it defaults to the repo's default branch). Then, if the preview is Autonoma-managed (PreviewKit), call trigger_deploy to rebuild the base preview at the new commit and poll get_session_status until it is \`ready\` again BEFORE you dry_run; if the app runs on its own hosting (e.g. Vercel / an existing deploy), wait for that deployment to finish first. Do NOT dry_run against a preview that is still building - you would just be testing the old code. Fastest of all: iterate the SDK handler and recipe LOCALLY first - run the app's Autonoma SDK against a local server + database, exercise the recipe, and confirm the rows actually landed in the DB - then push/update only once it works. A local loop is seconds; a cloud rebuild is minutes.

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
                        deployBranch: config.deployBranch,
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
                    return jsonResult({
                        document: config.document,
                        configExists: config.saved,
                        deployBranch: config.deployBranch,
                    });
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
                "Optionally pass `branch` to set which branch the base preview (environment 0) deploys from. If unset it uses the " +
                "repo's default branch (whatever it is named) - don't steer toward a branch name without cause. Set it " +
                "when the user is working on a different branch (check their checkout's current branch and ask which " +
                "to use). Validated against GitHub, so a typo is rejected. " +
                "Setting the branch here does NOT deploy - trigger_deploy does. " +
                "Pass a short `description` of what this save does - the user watches it on the activity feed.",
            inputSchema: {
                applicationId: z.string(),
                document: previewConfigSchema,
                branch: z
                    .string()
                    .min(1)
                    .optional()
                    .describe(
                        "Branch the base preview (environment 0) deploys from. Omit to use the repo's default branch; set it " +
                            "when the user is working on a different branch (ask them which to use).",
                    ),
                description: activityDescription,
            },
        },
        async ({ applicationId, document, branch, description }) =>
            guardedWrite(
                {
                    applicationId,
                    tool: "apply_config",
                    message: description ?? "Saving preview config",
                    toolArguments:
                        branch != null ? { apps: document.apps.length, branch } : { apps: document.apps.length },
                },
                async (org) => {
                    const saved = await services.onboarding.savePreviewkitConfig(applicationId, org, document);
                    if (branch == null) return saved;
                    const { branch: deployBranch } = await services.onboarding.setDeployBranch(
                        applicationId,
                        org,
                        branch,
                    );
                    return { ...saved, deployBranch };
                },
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
                "Deploy the app's configured deploy branch as the base preview (environment 0), applying the " +
                "saved config. If unset the deploy branch is the repo's default branch - but if the user's checkout is " +
                "on a different branch, ask which to use and set it with apply_config's `branch` field before deploying, " +
                "rather than steering to the default. Then poll get_session_status until it is up, and verify the preview " +
                "URL yourself. Pass a short `description` of what you are deploying - the user watches it on the activity feed.",
            inputSchema: { applicationId: z.string(), description: activityDescription },
        },
        async ({ applicationId, description }) =>
            guardedWrite(
                {
                    applicationId,
                    tool: "trigger_deploy",
                    message: description ?? "Deploying preview (default branch)",
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
                "secret, then redeploy. When status is `ready`, recentLogs carries the app's RUNTIME logs: exercise " +
                "the main flow against the preview URL, then read them - a passing health check does not mean the " +
                "app works, and erroring logs behind a ready status mean you are not done. " +
                "If it reports standDown, the user took over - stop configuring.",
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

    server.registerTool(
        "list_scenarios",
        {
            title: "List scenarios",
            description:
                "List the app's scenarios (named test-data states a test depends on) and whether each already has a " +
                "recipe. Use a returned scenarioId with get_recipe / update_recipe / dry_run_scenario. A recipe is the " +
                "JSON your deployed Autonoma SDK follows to create that scenario's entities in the app's own database.",
            inputSchema: { applicationId: z.string() },
        },
        async ({ applicationId }) =>
            analytics.track("list_scenarios", async () => {
                try {
                    const organizationId = await resolveOrg(applicationId);
                    const scenarios = await services.scenarios.listScenarios(applicationId, organizationId);
                    return jsonResult({
                        scenarios: scenarios.map((scenario) => ({
                            id: scenario.id,
                            name: scenario.name,
                            isDisabled: scenario.isDisabled,
                            hasRecipe: scenario.activeRecipeVersionId != null,
                        })),
                    });
                } catch (err) {
                    logger.warn("list_scenarios failed", { applicationId, err });
                    return toToolResult(err);
                }
            }),
    );

    server.registerTool(
        "get_recipe",
        {
            title: "Read a scenario recipe",
            description:
                "Read a scenario's current recipe - the JSON `create` graph (plus `variables`) your SDK endpoint uses " +
                "to build that scenario's entities in the app's database. Edit it and send it back with update_recipe. " +
                "Returns `fixtureJson: null` when the scenario has no recipe yet.",
            inputSchema: { applicationId: z.string(), scenarioId: z.string() },
        },
        async ({ applicationId, scenarioId }) =>
            analytics.track("get_recipe", async () => {
                try {
                    const organizationId = await resolveOrg(applicationId);
                    const recipe = await services.scenarios.getRecipe(scenarioId, organizationId);
                    return jsonResult(recipe);
                } catch (err) {
                    logger.warn("get_recipe failed", { applicationId, scenarioId, err });
                    return toToolResult(err);
                }
            }),
    );

    server.registerTool(
        "update_recipe",
        {
            title: "Update a scenario recipe",
            description:
                "Replace a scenario's recipe with a corrected version and make it the active one. The recipe's `name` " +
                "must stay the scenario's existing name - this EDITS an existing scenario, it does not create one (the " +
                "scenario and an initial recipe come from the planner upload). The recipe is validated against the " +
                "recipe schema on save; an invalid shape is rejected with the exact field paths and messages that are " +
                "wrong, so read them, fix those fields, and resend. After saving, call dry_run_scenario to run it " +
                "against the deployed app and confirm it actually creates the entities; loop update_recipe -> " +
                "dry_run_scenario until it passes. Pass a short `description` of what you changed - the user watches it " +
                "on the activity feed.",
            inputSchema: {
                applicationId: z.string(),
                scenarioId: z.string(),
                recipe: ScenarioRecipeSchema,
                description: activityDescription,
            },
        },
        async ({ applicationId, scenarioId, recipe, description }) =>
            guardedWrite(
                {
                    applicationId,
                    tool: "update_recipe",
                    message: description ?? `Updating recipe for scenario "${recipe.name}"`,
                    toolArguments: { scenarioId, scenario: recipe.name },
                },
                (org) => services.scenarios.updateRecipe(scenarioId, JSON.stringify(recipe), org),
            ),
    );

    server.registerTool(
        "dry_run_scenario",
        {
            title: "Test a scenario recipe",
            description:
                "Run a scenario's recipe end-to-end against the deployed app: calls your SDK endpoint `up` to create " +
                "the entities in the app's database, then `down` to tear them back down. This is how you confirm a " +
                "recipe works before onboarding completes. On failure it returns which phase failed (up/down) and the " +
                "SDK's error, so you can fix the recipe with update_recipe and retry. Requires the app deployed with " +
                "its SDK URL + signing secret configured - get the preview up first. Cold starts are handled for you: a " +
                "scaled-to-zero ('serverless') preview 503s on the first hit while it wakes, so this tool waits through " +
                "that warm-up (a bounded retry, ~30s) before running - allow the first run extra time rather than " +
                "treating a slow response as a hang, and you normally never see the 503. Only if the preview is STILL " +
                "cold after that wait does it return `success:false` with `coldStart:true` and a plain-English note " +
                "(not a raw 503); then just call dry_run_scenario again, the environment is waking. Pass a short " +
                "`description` - the user watches it on the activity feed.",
            inputSchema: { applicationId: z.string(), scenarioId: z.string(), description: activityDescription },
        },
        async ({ applicationId, scenarioId, description }) =>
            guardedWrite(
                {
                    applicationId,
                    tool: "dry_run_scenario",
                    message: description ?? "Testing scenario recipe",
                    toolArguments: { scenarioId },
                },
                (org) => services.scenarios.dryRun(applicationId, org, scenarioId),
            ),
    );

    // ─── Prompt: a guided entry point the user can invoke ─────────────
    server.registerPrompt(
        "configure_preview",
        {
            title: "Configure my Autonoma preview",
            description:
                "Guided flow to configure, deploy, and verify this app's Autonoma preview during onboarding (and fix " +
                "its scenario recipes), using the pairing code from the Autonoma UI.",
            argsSchema: { code: z.string().optional() },
        },
        ({ code }) => {
            const pairingStep =
                code != null && code.length > 0
                    ? `Pair with code ${code}, then work`
                    : `Get the pairing code from the Autonoma UI ("Configure with coding agent") and call pair with it, then work`;
            return {
                messages: [
                    {
                        role: "user",
                        content: {
                            type: "text",
                            text:
                                `Configure my Autonoma preview during onboarding. ${pairingStep} the loop below until ` +
                                `the preview is up and its scenario recipes pass.\n\n${ONBOARDING_INSTRUCTIONS}`,
                        },
                    },
                ],
            };
        },
    );

    // ─── Resource: the onboarding guide, readable on demand ───────────
    server.registerResource(
        "onboarding-guide",
        "autonoma://onboarding-guide",
        {
            title: "Autonoma preview onboarding guide",
            description:
                "What Autonoma is and how to configure, deploy, and verify this app's preview - and fix its scenario " +
                "recipes - with these tools, in order.",
            mimeType: "text/markdown",
        },
        (uri) => ({
            contents: [{ uri: uri.href, text: ONBOARDING_INSTRUCTIONS, mimeType: "text/markdown" }],
        }),
    );

    return server;
}
