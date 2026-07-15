import { NotFoundError } from "@autonoma/errors";
import { logger as rootLogger } from "@autonoma/logger";
import { previewConfigSchema } from "@autonoma/types";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PreviewLogLine } from "../previewkit/previewkit-logs.service";
import type { Services } from "../routes/build-services";
import { derivePreviewSdkUrl } from "../routes/deployments/preview-sdk-url";
import type { McpAnalytics } from "./mcp-analytics";
import { jsonResult, toToolResult, unavailableResult } from "./tool-result";

/** Ceiling on log lines a single tail tool can request. */
const MAX_LOG_LINES = 1000;
const DEFAULT_LOG_LINES = 200;
/** How many recent log lines wait_for_deploy attaches so the agent sees live progress (or the failure). */
const WAIT_RECENT_LOG_LINES = 20;
/** Watched statuses whose relevant logs are the BUILD stream; everything else reads the app (runtime) stream. */
const BUILD_PHASE_STATUSES = new Set(["pending", "building", "build_failed", "failed"]);

/**
 * Server-level guidance the MCP client reads on connect. It is the portable,
 * client-agnostic place to teach an agent what Autonoma is and how to debug a
 * broken preview - so a Cursor / Codex / Claude agent that has never heard of
 * Autonoma still knows the recommended flow without a per-client skill.
 */
const DEBUG_INSTRUCTIONS = `Autonoma runs your end-to-end tests against a per-PR preview deployment of your app and reviews the result. When a preview fails to build or deploy, or a test fails because the app is broken, these tools let you read the live evidence and fix the cause in this repo.

Every tool is keyed by repoFullName ("owner/repo"). You almost never need to ask the user for it:
- It is this repository's GitHub remote. Infer it from the working directory (e.g. run \`git remote get-url origin\` and parse "owner/repo"). Use that directly.
- Only if you are not inside the app's repo, or can't determine the remote, call list_apps to see the repos you can debug and ask the user which one.
You do NOT need GitHub access - repoFullName is just how Autonoma identifies your app; the org is inferred from it and you must be a member.

Recommended flow when Autonoma flags a problem on a pull request:
1. Call get_deploy_status(repoFullName, prNumber) to see which service is unhealthy and whether it failed at build or at runtime.
2. If a service failed to BUILD: call get_build_logs (start with from="tail" to see the failure; use from="head" for the start of the build). Missing build inputs often show up as a missing env var.
3. If a service BUILT but crashes or errors at RUNTIME: call get_app_logs (from="tail" for the crash, from="head" for startup).
4. Call diagnose_deploy(repoFullName, prNumber) to get all the raw evidence in one call - status, each service/addon state, the latest build outcome, a rule-based failure classification, the config's env-key surface, and error-shaped logs - plus deterministic findings categorized as a missing env var, a setup problem, or a platform error. Reason over the signals yourself; a "platform error" (autonoma_error) is on Autonoma, so contact support rather than editing your repo.
5. Call get_secret_status(repoFullName) to see the full env-var surface per app: topology connections (with their template values) and secret-backed vars (declared build secrets + registered runtime secrets), including which declared build secrets are missing. Secret VALUES are never returned - only presence and masked length.
6. Apply the fix. Three kinds:
   - A missing secret VALUE (an API key, token, password): call set_secret(repoFullName, prNumber, app, key, value). It stores the value and rebuilds or restarts the service automatically.
   - How ONE existing service is built or wired (build path, Dockerfile, port, health check, which keys are injected at build, topology connections): call edit_previewkit_config(repoFullName, prNumber, app, ...the fields to change). It saves a new config revision and rebuilds the service.
   - The SHAPE of the preview (add or remove an app, add or remove a service like a database or a redis cache): call get_config(repoFullName) to read the full document, edit it, and send it back with apply_config(repoFullName, prNumber, document). It redeploys the whole environment.
   For anything in your source (code, a committed Dockerfile), edit this repo and push - Autonoma re-runs on the new commit.
7. set_secret, edit_previewkit_config, and apply_config trigger the rebuild/restart asynchronously. Call wait_for_deploy(repoFullName, prNumber, app) to block until it settles, then re-check status/logs. If it returns settled:false, the deploy is still running - call it again.

Live vs. forensic surface: get_deploy_status, get_endpoints, and wait_for_deploy read the LIVE environment, which Autonoma tears down after testing - once it is gone they return status: "unavailable". The LOGS (get_build_logs, get_app_logs) are different: they persist ~30 days independent of the live environment. So an "unavailable" deploy status does NOT mean the logs are gone. For a post-mortem of a past deploy ("why did this PR's last preview fail?"), call the log tools directly even when status is unavailable.

Keys: every tool takes repoFullName ("owner/repo"); the per-PR tools also take prNumber. The organization is inferred from the repo (which you must be a member of), so everything is automatically scoped to it.`;

/** The snippet the `setup_autonoma` prompt asks the agent to add to AGENTS.md / CLAUDE.md. */
const AGENTS_MD_SNIPPET = `## Autonoma

After you push a PR, Autonoma reviews its preview deploy. If it flagged a problem, use the Autonoma MCP tools to find the cause (get_deploy_status, diagnose_deploy, get_build_logs, get_app_logs, get_secret_status), fix it (set_secret for a missing secret value, edit_previewkit_config for build/wiring changes), and confirm with wait_for_deploy - before merging. The tools take this repo as "owner/repo" - infer it from the git remote; if unsure, call list_apps.`;

/** Everything a debug MCP tool needs: the service graph and a per-repo org resolver. */
export interface DebugMcpDeps {
    services: Services;
    /**
     * Resolve the organization a call acts in from the `repoFullName` it names,
     * verifying the authenticated user is a member. Throws NotFoundError when the
     * repo has no preview environment or the user is not a member of its org.
     */
    resolveOrg: (repoFullName: string) => Promise<string>;
    /** List the repos the authenticated user can debug (across their orgs). */
    listRepos: () => Promise<{ repos: { repoFullName: string; organization: string }[]; truncated: boolean }>;
    /** Records a `mcp.tool_called` PostHog event per tool invocation, per customer org. */
    analytics: McpAnalytics;
}

/** Shared `(repoFullName, prNumber)` tool input - the previewkit execution key. */
const repoPrInput = {
    repoFullName: z.string().regex(/^[^/]+\/[^/]+$/, "must be 'owner/repo'"),
    prNumber: z.number().int().min(0),
};

/**
 * The `unavailable` result for a PR whose LIVE preview environment is gone
 * (never deployed, or - far more often - torn down after Autonoma finished
 * testing). It steers the agent to the forensic surface: build/app logs outlive
 * the environment by ~30 days, so a torn-down env is not a dead end for a
 * post-mortem. Without this nudge an agent reads "not found" as "nothing here"
 * and gives up (or needlessly redeploys) instead of pulling the logs.
 */
function noLiveEnvResult(repoFullName: string, prNumber: number) {
    return unavailableResult(
        `No live preview environment for ${repoFullName} PR ${prNumber} - it was never deployed, or (more often) ` +
            `it was torn down after Autonoma finished testing. The live surface (deploy status, endpoints) is gone, ` +
            `but build and app logs persist ~30 days: call get_build_logs / get_app_logs to inspect the last deploy.`,
    );
}

/**
 * Builds the "debug" MCP server: the client-facing, previewkit-scoped slice of
 * Workstream B. Every tool resolves its org from the `repoFullName` it names via
 * `deps.resolveOrg` (which verifies the authenticated user is a member) and then
 * reuses an existing org-scoped service - this layer only maps the agent-friendly
 * execution key (repoFullName, and prNumber where per-PR) onto those services.
 * Resolving per-repo (not a fixed org) is what lets a multi-org user's token work
 * unambiguously. Secret VALUES are never returned; `get_secret_status` reports
 * presence + masked length only.
 *
 * Tools keyed by `snapshotId` (tests / reviews / runs) are intentionally absent:
 * they are blocked on the diffs-vs-investigation reconciliation.
 */
export function buildDebugMcpServer(deps: DebugMcpDeps): McpServer {
    const logger = rootLogger.child({ name: "debugMcpServer" });
    const { services, resolveOrg, listRepos, analytics } = deps;

    const server = new McpServer({ name: "autonoma-debug", version: "0.1.0" }, { instructions: DEBUG_INSTRUCTIONS });

    server.registerTool(
        "list_apps",
        {
            title: "List your debuggable apps",
            description:
                "List the repos ('owner/repo') you can debug - every repo with an Autonoma preview environment in " +
                "an organization you belong to. Call this when you don't already know the repoFullName (e.g. it " +
                "isn't inferable from this repo's git remote) so you can pick one. Takes no arguments.",
            inputSchema: {},
            annotations: { readOnlyHint: true },
        },
        async () =>
            analytics.track("list_apps", async () => {
                logger.info("list_apps");
                try {
                    const result = await listRepos();
                    return jsonResult(result);
                } catch (err) {
                    return toToolResult(err);
                }
            }),
    );

    server.registerTool(
        "get_deploy_status",
        {
            title: "Get preview deploy status",
            description:
                "Per-service deploy status for a PR's preview environment: overall health, each service's " +
                "status/endpoint/build outcome, and the latest build. Start here when a preview is broken.",
            inputSchema: repoPrInput,
            annotations: { readOnlyHint: true },
        },
        async ({ repoFullName, prNumber }) =>
            analytics.track("get_deploy_status", async () => {
                logger.info("get_deploy_status", { extra: { repoFullName, prNumber } });
                try {
                    const organizationId = await resolveOrg(repoFullName);
                    const app = await services.applications.findByRepoFullName(repoFullName, organizationId);
                    const summary = await tryPreviewSummary(app.id, prNumber, organizationId);
                    if (summary == null) return noLiveEnvResult(repoFullName, prNumber);
                    return jsonResult(summary);
                } catch (err) {
                    return toToolResult(err);
                }
            }),
    );

    server.registerTool(
        "get_endpoints",
        {
            title: "Get preview endpoints",
            description:
                "The reachable URLs for a PR's preview: the primary preview URL, a suggested SDK base URL, and one " +
                "entry per service. A service with `url: null` has no public HTTP endpoint (it's an internal " +
                "service like a database or cache, reachable only by other services inside the preview, or it isn't " +
                "exposed) - the entry carries a `reason`, so a service count higher than the number of URLs is " +
                "expected, not a bug. Use the URLs to hit the deployed app directly.",
            inputSchema: repoPrInput,
            annotations: { readOnlyHint: true },
        },
        async ({ repoFullName, prNumber }) =>
            analytics.track("get_endpoints", async () => {
                logger.info("get_endpoints", { extra: { repoFullName, prNumber } });
                try {
                    const organizationId = await resolveOrg(repoFullName);
                    const app = await services.applications.findByRepoFullName(repoFullName, organizationId);
                    const summary = await tryPreviewSummary(app.id, prNumber, organizationId);
                    if (summary == null) return noLiveEnvResult(repoFullName, prNumber);
                    const endpoints = summary.services.map((service) => {
                        const hasUrl = service.endpoint != null && service.endpoint !== "";
                        if (hasUrl) return { name: service.name, url: service.endpoint };
                        return {
                            name: service.name,
                            url: null,
                            reason:
                                "No public HTTP endpoint - this is an internal service (e.g. a database or cache) " +
                                "reachable only by other services inside the preview, or it is not exposed.",
                        };
                    });
                    return jsonResult({
                        primaryUrl: summary.primaryUrl,
                        sdkUrl: derivePreviewSdkUrl(summary.primaryUrl, undefined),
                        endpoints,
                    });
                } catch (err) {
                    return toToolResult(err);
                }
            }),
    );

    server.registerTool(
        "get_build_logs",
        {
            title: "Get preview build logs",
            description:
                "Build-log lines for a PR's preview. Previews are multi-service; omit `app` to get all services " +
                "(the result's `services` field lists which produced output), or pass one service name to narrow. " +
                "`from` picks the window: 'tail' (newest, default) for where a build failed, or 'head' for the start " +
                "of the build. `filter` is a case-insensitive substring pre-filter. An empty `lines` with " +
                "`available: true` means the window genuinely had no output. Logs persist ~30 days and remain " +
                "readable after the preview is torn down - you can pull a past deploy's build logs even when " +
                "get_deploy_status reports the environment is gone.",
            inputSchema: {
                ...repoPrInput,
                app: appNameSchema(),
                limit: logLimitSchema(),
                filter: logFilterSchema(),
                from: logFromSchema(),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ repoFullName, prNumber, app, limit, filter, from }) =>
            analytics.track("get_build_logs", () =>
                tailLogs("build", { repoFullName, prNumber, app, limit, filter, from }),
            ),
    );

    server.registerTool(
        "get_app_logs",
        {
            title: "Get preview app logs",
            description:
                "Runtime (stdout/stderr) log lines for a PR's preview. Previews are multi-service (e.g. 'web' + " +
                "'db'); omit `app` to get all services (the result's `services` field lists which produced output), " +
                "or pass one service name to narrow. `from` picks the window: 'tail' (newest, default) for a crash, " +
                "or 'head' for startup. `filter` is a case-insensitive substring pre-filter. An empty `lines` with " +
                "`available: true` means the window genuinely had no output. Use when a service built but errors at " +
                "runtime. Like build logs, these persist ~30 days and remain readable after the preview is torn down, " +
                "so they work for a post-mortem even when get_deploy_status reports no environment.",
            inputSchema: {
                ...repoPrInput,
                app: appNameSchema(),
                limit: logLimitSchema(),
                filter: logFilterSchema(),
                from: logFromSchema(),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ repoFullName, prNumber, app, limit, filter, from }) =>
            analytics.track("get_app_logs", () =>
                tailLogs("app", { repoFullName, prNumber, app, limit, filter, from }),
            ),
    );

    server.registerTool(
        "diagnose_deploy",
        {
            title: "Diagnose a failed preview deploy",
            description:
                "The raw diagnostic signals for a PR's preview deploy, for you to reason over: overall status, each " +
                "service's and addon's state, the latest build outcome, a rule-based failure classification, the " +
                "config's env-key surface (never secret values), and error-shaped log lines. Also includes " +
                "deterministic `findings` (categorized missing_env_var / user_setup / autonoma_error) you can trust " +
                'as a starting point. `status: "ok"` means no failure was detected. Use when get_deploy_status shows ' +
                "a failure and you want the full evidence in one call.",
            inputSchema: repoPrInput,
            annotations: { readOnlyHint: true },
        },
        async ({ repoFullName, prNumber }) =>
            analytics.track("diagnose_deploy", async () => {
                logger.info("diagnose_deploy", { extra: { repoFullName, prNumber } });
                try {
                    const organizationId = await resolveOrg(repoFullName);
                    const app = await services.applications.findByRepoFullName(repoFullName, organizationId);
                    const result = await services.previewkitDiagnosis.signals(organizationId, {
                        applicationId: app.id,
                        prNumber,
                    });
                    return jsonResult(result);
                } catch (err) {
                    return toToolResult(err);
                }
            }),
    );

    server.registerTool(
        "get_secret_status",
        {
            title: "Get env-var and secret status",
            description:
                "The full env-var surface per app, so you can see every variable you may need to change: " +
                "`connections` are topology-wired vars with their (non-secret) template values shown as-is; " +
                "`secrets` are secret-backed vars (declared build secrets plus any registered runtime secrets) with " +
                "presence, masked length, and a non-reversible `fingerprint` (first 12 hex of SHA-256 of the value) - " +
                "never the value itself; hash a value you hold as sha256(value).hex.slice(0,12) and compare to check a " +
                "match. `missingBuildSecrets` are declared build secrets with no value set (a concrete misconfig to " +
                "fix). Takes the repo ('owner/repo').",
            inputSchema: { repoFullName: repoPrInput.repoFullName },
            annotations: { readOnlyHint: true },
        },
        async ({ repoFullName }) =>
            analytics.track("get_secret_status", async () => {
                logger.info("get_secret_status", { extra: { repoFullName } });
                try {
                    const organizationId = await resolveOrg(repoFullName);
                    const app = await services.applications.findByRepoFullName(repoFullName, organizationId);
                    const status = await services.previewkitSecretStatus.status(app.id, organizationId);
                    return jsonResult(status);
                } catch (err) {
                    return toToolResult(err);
                }
            }),
    );

    server.registerTool(
        "set_secret",
        {
            title: "Set or remove a secret env var",
            description:
                "Set (or, by omitting `value`, remove) the VALUE of a secret env var for one service of a PR's " +
                "preview - an API key, token, password, or any variable whose value should not live in the repo. The " +
                "value is stored encrypted and never returned. This is the fix for a missing env var. You do NOT say " +
                "whether it's a build-time or runtime var: the tool reads your config and applies the minimal action " +
                "itself - it rebuilds the service if the key is a declared build secret (the value is baked into the " +
                "image at build), otherwise it restarts the service (a runtime secret). It never edits your config " +
                "structure. To declare which keys are injected at build, add a connection, or change the " +
                "Dockerfile/path/port, use edit_previewkit_config. Rule of thumb: a secret VALUE goes here; how the " +
                "app is built or wired goes to edit_previewkit_config. The response returns a non-reversible " +
                "`fingerprint` of the value you set (first 12 hex of SHA-256) so you can confirm it. The " +
                "rebuild/restart is async - call wait_for_deploy(repoFullName, prNumber, app) afterward to block " +
                "until it settles.",
            inputSchema: {
                ...repoPrInput,
                app: requiredAppNameSchema(),
                key: z.string().min(1).max(255),
                value: z.string().min(1).max(65536).optional(),
            },
            annotations: { readOnlyHint: false, destructiveHint: true },
        },
        async ({ repoFullName, prNumber, app, key, value }) =>
            analytics.track("set_secret", async () => {
                logger.info("set_secret", { extra: { repoFullName, prNumber, app, key, removing: value == null } });
                try {
                    const organizationId = await resolveOrg(repoFullName);
                    const application = await services.applications.findByRepoFullName(repoFullName, organizationId);
                    const result = await services.previewkitWrite.setSecret({
                        applicationId: application.id,
                        repoFullName,
                        prNumber,
                        appName: app,
                        key,
                        value,
                        organizationId,
                    });
                    return jsonResult(result);
                } catch (err) {
                    return toToolResult(err);
                }
            }),
    );

    server.registerTool(
        "edit_previewkit_config",
        {
            title: "Edit the preview config",
            description:
                "Change the STRUCTURAL preview config for one service of a PR's preview: its build `path`, " +
                "`dockerfile`, `port`, `healthCheck`, the env-var keys injected at build time (`buildSecrets`), or its " +
                "topology `connections` (non-secret env wired to other services - values are templates like " +
                '"{{db.url}}"). Only the fields you pass are changed; the rest are kept. Saves a new config revision ' +
                "and, unless `apply` is false, rebuilds the service against it (pass apply:false to stage several " +
                "edits, then apply the last). It never sets a secret VALUE - use set_secret for an API key, token, or " +
                "password. This edits ONE existing service in place - to ADD or REMOVE a service (a database, a redis " +
                "cache, a side-container) or an app, use get_config + apply_config instead. Rule of thumb: a secret " +
                "value -> set_secret; how one service is built or wired -> here; reshape the preview -> apply_config. " +
                "The rebuild is async - call wait_for_deploy(repoFullName, prNumber, app) afterward to block until it settles.",
            inputSchema: {
                ...repoPrInput,
                app: requiredAppNameSchema(),
                path: z.string().min(1).max(1024).optional(),
                dockerfile: z.string().min(1).max(1024).optional(),
                port: z.number().int().positive().max(65535).optional(),
                healthCheck: z.string().min(1).max(1024).optional(),
                buildSecrets: z.array(z.string().min(1).max(255)).max(100).optional(),
                connections: z
                    .array(
                        z.object({
                            key: z.string().min(1).max(255),
                            value: z.string().min(1).max(4096),
                            buildTime: z.boolean().optional(),
                        }),
                    )
                    .max(100)
                    .optional(),
                apply: z.boolean().optional(),
            },
            annotations: { readOnlyHint: false, destructiveHint: false },
        },
        async ({
            repoFullName,
            prNumber,
            app,
            path,
            dockerfile,
            port,
            healthCheck,
            buildSecrets,
            connections,
            apply,
        }) =>
            analytics.track("edit_previewkit_config", async () => {
                logger.info("edit_previewkit_config", { extra: { repoFullName, prNumber, app, apply } });
                try {
                    const organizationId = await resolveOrg(repoFullName);
                    const application = await services.applications.findByRepoFullName(repoFullName, organizationId);
                    const result = await services.previewkitWrite.editConfig({
                        applicationId: application.id,
                        repoFullName,
                        prNumber,
                        appName: app,
                        patch: { path, dockerfile, port, healthCheck, buildSecrets, connections },
                        apply: apply ?? true,
                        organizationId,
                    });
                    return jsonResult(result);
                } catch (err) {
                    return toToolResult(err);
                }
            }),
    );

    server.registerTool(
        "get_config",
        {
            title: "Read the full preview config",
            description:
                "Read the FULL preview config document: every app, service (databases, caches, side-containers), " +
                "addon, and hook - no secret values. Read this first when you need to change the SHAPE of the preview " +
                "(add or remove an app or a service), then edit the document and send it back with apply_config. For " +
                "a build/wiring tweak to ONE existing service, edit_previewkit_config is simpler and doesn't need the " +
                "whole document. The config is per-app, so this takes only repoFullName.",
            inputSchema: { repoFullName: repoPrInput.repoFullName },
            annotations: { readOnlyHint: true },
        },
        async ({ repoFullName }) =>
            analytics.track("get_config", async () => {
                logger.info("get_config", { extra: { repoFullName } });
                try {
                    const organizationId = await resolveOrg(repoFullName);
                    const application = await services.applications.findByRepoFullName(repoFullName, organizationId);
                    const result = await services.previewkitWrite.getConfig(application.id, organizationId);
                    return jsonResult(result);
                } catch (err) {
                    return toToolResult(err);
                }
            }),
    );

    server.registerTool(
        "apply_config",
        {
            title: "Save the full preview config",
            description:
                "Save the FULL preview config document (read it with get_config first, edit it, send the whole " +
                "document back). This is how you change the SHAPE of the preview that a single-service edit can't: add " +
                "or remove an app, or add or remove a service (a database, a cache like redis, or a side-container). " +
                "Validated on save; an invalid document returns the errors to fix. Never include secret VALUES - " +
                "declare secret keys in an app's build_secrets and set values with set_secret. Unless `apply` is " +
                "false, redeploys the WHOLE environment against the new document (a topology change touches more than " +
                "one service). Rule of thumb: reshape the preview -> here; tweak one existing service's build/wiring " +
                "-> edit_previewkit_config; a secret value -> set_secret. The redeploy is async - call " +
                "wait_for_deploy(repoFullName, prNumber) afterward to block until it settles.",
            inputSchema: {
                ...repoPrInput,
                document: previewConfigSchema,
                apply: z.boolean().optional(),
            },
            annotations: { readOnlyHint: false, destructiveHint: true },
        },
        async ({ repoFullName, prNumber, document, apply }) =>
            analytics.track("apply_config", async () => {
                logger.info("apply_config", {
                    extra: {
                        repoFullName,
                        prNumber,
                        apps: document.apps.length,
                        services: document.services.length,
                        apply,
                    },
                });
                try {
                    const organizationId = await resolveOrg(repoFullName);
                    const application = await services.applications.findByRepoFullName(repoFullName, organizationId);
                    const result = await services.previewkitWrite.applyConfig({
                        applicationId: application.id,
                        repoFullName,
                        prNumber,
                        document,
                        apply: apply ?? true,
                        organizationId,
                    });
                    return jsonResult(result);
                } catch (err) {
                    return toToolResult(err);
                }
            }),
    );

    server.registerTool(
        "wait_for_deploy",
        {
            title: "Wait for a preview deploy to settle",
            description:
                "Block until a PR's preview deploy reaches a terminal state (ready or failed), then return the " +
                "outcome - so after set_secret or edit_previewkit_config trigger a rebuild, you can wait here and " +
                "then keep debugging. Pass the `app` you just changed to watch that service's rebuild (recommended); " +
                "omit it to watch the whole environment (e.g. after a fresh deploy). It waits server-side up to ~45s " +
                "per call; if it returns `settled: false` the deploy is still in progress - call it again to keep " +
                "waiting. When `settled: true`, check `appStatus`/`status` (a *_failed status) and, if it failed, use " +
                "get_build_logs / get_app_logs / diagnose_deploy to find out why. Each response also carries the " +
                "last few log lines (`recentLogs`) from the phase-relevant stream, so you can see it is progressing " +
                "(and, on failure, often the cause) without a separate log call.",
            inputSchema: {
                ...repoPrInput,
                app: appNameSchema(),
                timeoutSeconds: z.number().int().min(5).max(55).optional(),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ repoFullName, prNumber, app, timeoutSeconds }) =>
            analytics.track("wait_for_deploy", async () => {
                logger.info("wait_for_deploy", { extra: { repoFullName, prNumber, app } });
                try {
                    const organizationId = await resolveOrg(repoFullName);
                    const result = await services.previewkitEnvironments.waitForDeploy({
                        repoFullName,
                        prNumber,
                        appName: app,
                        callerOrgId: organizationId,
                        timeoutMs: timeoutSeconds != null ? timeoutSeconds * 1000 : undefined,
                    });
                    if (result == null) {
                        return noLiveEnvResult(repoFullName, prNumber);
                    }
                    const recentLogs = await tailRecentLogs(result.appStatus ?? result.status, {
                        repoFullName,
                        prNumber,
                        app,
                        organizationId,
                    });
                    return jsonResult({ ...result, recentLogs });
                } catch (err) {
                    return toToolResult(err);
                }
            }),
    );

    // ─── Prompts: guided flows the user can invoke ────────────────────
    server.registerPrompt(
        "debug_broken_preview",
        {
            title: "Debug a broken preview",
            description: "Guided flow to find and fix why a pull request's Autonoma preview deploy failed.",
            argsSchema: { repoFullName: z.string(), prNumber: z.string() },
        },
        ({ repoFullName, prNumber }) => ({
            messages: [
                {
                    role: "user",
                    content: {
                        type: "text",
                        text:
                            `Autonoma flagged a problem on the preview for ${repoFullName} PR ${prNumber}. ` +
                            `Find the root cause and fix it in this repo.\n\n${DEBUG_INSTRUCTIONS}`,
                    },
                },
            ],
        }),
    );

    server.registerPrompt(
        "setup_autonoma",
        {
            title: "Add Autonoma to this repo's agent instructions",
            description:
                "Add a short Autonoma section to AGENTS.md / CLAUDE.md so your agent checks previews automatically.",
        },
        () => ({
            messages: [
                {
                    role: "user",
                    content: {
                        type: "text",
                        text:
                            `Add the following section to this repo's AGENTS.md (or CLAUDE.md if that is what this ` +
                            `project uses). If the file already has an Autonoma section, update it to match. Create ` +
                            `the file if it does not exist. Do not change anything else.\n\n${AGENTS_MD_SNIPPET}`,
                    },
                },
            ],
        }),
    );

    // ─── Resource: the debugging guide, readable on demand ────────────
    server.registerResource(
        "debugging-guide",
        "autonoma://debugging-guide",
        {
            title: "Autonoma preview debugging guide",
            description: "What Autonoma is and how to debug a broken preview with these tools.",
            mimeType: "text/markdown",
        },
        (uri) => ({
            contents: [{ uri: uri.href, text: DEBUG_INSTRUCTIONS, mimeType: "text/markdown" }],
        }),
    );

    return server;

    /**
     * The PR's preview summary, or undefined when its live environment is gone
     * (torn down after testing, or never deployed). Lets the live-surface tools
     * return {@link noLiveEnvResult} - which points at the still-available logs -
     * instead of a bare "not found". Non-NotFound errors (a repo/membership
     * failure surfaced upstream, a real backend fault) still propagate.
     */
    async function tryPreviewSummary(applicationId: string, prNumber: number, organizationId: string) {
        try {
            return await services.deployments.previewSummaryByPr(applicationId, prNumber, organizationId);
        } catch (err) {
            if (err instanceof NotFoundError) return undefined;
            throw err;
        }
    }

    async function tailLogs(
        source: "build" | "app",
        input: {
            repoFullName: string;
            prNumber: number;
            app?: string;
            limit?: number;
            filter?: string;
            from?: "head" | "tail";
        },
    ) {
        logger.info(`get_${source}_logs`, { extra: { repoFullName: input.repoFullName, prNumber: input.prNumber } });
        try {
            const organizationId = await resolveOrg(input.repoFullName);
            const result = await services.previewkitLogs.tail({
                repoFullName: input.repoFullName,
                prNumber: input.prNumber,
                source,
                callerOrgId: organizationId,
                app: input.app,
                limit: input.limit ?? DEFAULT_LOG_LINES,
                filter: input.filter,
                from: input.from,
            });
            if (result == null) {
                return unavailableResult(
                    `No ${source} logs found for ${input.repoFullName} PR ${input.prNumber} - the preview may never ` +
                        `have deployed, or its logs have aged out (retained ~30 days).`,
                );
            }
            return jsonResult(result);
        } catch (err) {
            return toToolResult(err);
        }
    }

    /**
     * A short tail of the phase-relevant log stream for a wait_for_deploy response:
     * build logs while the app is building/failed-to-build, otherwise runtime logs.
     * Best-effort - a log-tail failure (Loki unset or down) never fails the wait.
     */
    async function tailRecentLogs(
        watchedStatus: string,
        input: { repoFullName: string; prNumber: number; app?: string; organizationId: string },
    ): Promise<{ source: "build" | "app"; lines: PreviewLogLine[] } | undefined> {
        const source = BUILD_PHASE_STATUSES.has(watchedStatus) ? "build" : "app";
        try {
            const logs = await services.previewkitLogs.tail({
                repoFullName: input.repoFullName,
                prNumber: input.prNumber,
                source,
                callerOrgId: input.organizationId,
                app: input.app,
                limit: WAIT_RECENT_LOG_LINES,
                from: "tail",
            });
            if (logs == null || !logs.available) return undefined;
            return { source, lines: logs.lines };
        } catch (err) {
            logger.warn("wait_for_deploy recent-log tail failed", { extra: { source }, err });
            return undefined;
        }
    }
}

function appNameSchema() {
    return requiredAppNameSchema().optional();
}

function requiredAppNameSchema() {
    return z.string().regex(/^[a-zA-Z0-9._-]{1,63}$/, "invalid app name");
}

function logLimitSchema() {
    return z.number().int().min(1).max(MAX_LOG_LINES).optional();
}

function logFilterSchema() {
    return z.string().min(1).max(200).optional();
}

function logFromSchema() {
    return z.enum(["head", "tail"]).optional();
}
