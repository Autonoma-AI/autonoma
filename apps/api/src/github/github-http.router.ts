import { db } from "@autonoma/db";
import type { GitHubApp } from "@autonoma/github";
import { logger } from "@autonoma/logger";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { env } from "../env";
import { previewkitTriggerService } from "../previewkit/previewkit-service";
import type { PreviewDeployAction } from "../previewkit/previewkit-trigger.service";
import { buildGitHubApp } from "./github-app";
import { GitHubInstallationService } from "./github-installation.service";
import { verifyInstallState } from "./github-state";
import { PullRequestCacheService } from "./pull-request-cache.service";

type GitHubEnv = {
    Variables: {
        githubApp: GitHubApp;
        githubService: GitHubInstallationService;
    };
};

const githubApp = buildGitHubApp(env);
const githubService = new GitHubInstallationService(db, githubApp);
const prCacheService = new PullRequestCacheService(db, githubService);

export const githubHttpRouter = new Hono<GitHubEnv>();

githubHttpRouter.use("*", cors({ origin: "*" }));

githubHttpRouter.use("*", async (ctx, next) => {
    ctx.set("githubApp", githubApp);
    ctx.set("githubService", githubService);
    await next();
});

githubHttpRouter.get("/callback", async (ctx) => {
    const appUrl = process.env.APP_URL ?? "http://localhost:3000";

    const installationId = Number(ctx.req.query("installation_id"));
    const setupAction = ctx.req.query("setup_action");
    const state = ctx.req.query("state");

    if (Number.isNaN(installationId) || setupAction !== "install") {
        return ctx.redirect(`${appUrl}?error=invalid_callback`);
    }

    const statePayload = state != null ? verifyInstallState(state) : undefined;
    if (statePayload == null) {
        logger.warn("GitHub callback: missing or invalid state", { installationId });
        return ctx.redirect(`${appUrl}?error=invalid_state`);
    }
    const { organizationId, returnPath } = statePayload;

    const { githubService, githubApp } = ctx.var;

    try {
        const client = await githubApp.getInstallationClient(installationId);
        const installationData = await client.getInstallation(installationId);

        const account = installationData.account as { login?: string; id?: number; type?: string } | null;

        await githubService.handleInstallation(
            installationId,
            organizationId,
            account?.login ?? "unknown",
            account?.id ?? 0,
            account?.type ?? "Organization",
        );
    } catch (error) {
        logger.fatal("Failed to handle GitHub installation callback", error, { installationId });
        const errorBase = returnPath != null ? `${appUrl}${returnPath}` : appUrl;
        const errorSeparator = errorBase.includes("?") ? "&" : "?";
        return ctx.redirect(`${errorBase}${errorSeparator}error=install_failed`);
    }

    const successBase = returnPath != null ? `${appUrl}${returnPath}` : appUrl;
    const successSeparator = successBase.includes("?") ? "&" : "?";
    return ctx.redirect(`${successBase}${successSeparator}connected=true`);
});

const WEBHOOK_EVENT_TYPES = {
    "installation.created": "installation_created",
    "installation.deleted": "installation_deleted",
    "installation.suspend": "installation_suspend",
    "installation.unsuspend": "installation_unsuspend",
    "installation_repositories.added": "installation_repositories_added",
    "installation_repositories.removed": "installation_repositories_removed",
    "pull_request.opened": "pull_request_opened",
    "pull_request.synchronize": "pull_request_synchronize",
    "pull_request.closed": "pull_request_closed",
    "pull_request.reopened": "pull_request_reopened",
    "pull_request.ready_for_review": "pull_request_ready_for_review",
    // push payloads carry no `action`; the event name alone is the key.
    push: "push",
} as const;

/** The internal event names this handler dispatches on, derived from the map. */
type GitHubWebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[keyof typeof WEBHOOK_EVENT_TYPES];

githubHttpRouter.post("/webhook", async (ctx) => {
    const body = await ctx.req.text();
    const signature = ctx.req.header("x-hub-signature-256") ?? "";
    const event = ctx.req.header("x-github-event") ?? "";
    const deliveryId = ctx.req.header("x-github-delivery") ?? "";

    const { githubApp, githubService } = ctx.var;

    const isValid = await githubApp.verifyWebhook(body, signature);
    if (!isValid) {
        logger.warn("Invalid GitHub webhook signature");
        return ctx.json({ error: "Invalid signature" }, 401);
    }

    if (deliveryId === "") {
        logger.warn("GitHub webhook missing X-GitHub-Delivery header");
        return ctx.json({ error: "Missing delivery id" }, 400);
    }

    const payload = JSON.parse(body) as Record<string, unknown>;
    const action = payload.action as string | undefined;
    const eventKey = action != null ? `${event}.${action}` : event;
    const eventType = isWebhookEventKey(eventKey) ? WEBHOOK_EVENT_TYPES[eventKey] : undefined;

    const installation = payload.installation as { id: number; account?: { login?: string } } | undefined;
    const installationId = installation?.id;

    // Ignore events we don't model. GitHub retries non-2xx, so still return 200.
    if (eventType == null || installationId == null) {
        logger.info("GitHub webhook: ignored event", { event, action, deliveryId });
        return ctx.json({ ok: true, ignored: true });
    }

    const organizationId = await githubService.findOrganizationIdByInstallationId(installationId);
    if (organizationId == null) {
        logger.warn("GitHub webhook: no organization linked to installation", { installationId, deliveryId });
        return ctx.json({ ok: true, ignored: true });
    }

    // push fires for every branch of every connected repo; only one that
    // updates a live main-branch preview environment is modeled. Irrelevant
    // pushes are dropped here before any deploy work is dispatched.
    if (eventType === "push" && !(await pushUpdatesMainBranchPreview(organizationId, payload))) {
        logger.info("GitHub webhook: push does not update a main-branch preview", { organizationId, deliveryId });
        return ctx.json({ ok: true, ignored: true });
    }

    // Ack immediately and process in the background. Superseding an in-flight
    // preview deploy waits (tens of seconds) for the old run to cancel
    // gracefully before starting its replacement; awaiting that here would blow
    // GitHub's 10s webhook delivery timeout and surface as failed deliveries.
    // The dispatched work is durable (Temporal), so a thrown error only needs
    // logging: GitHub gets 200 either way, and redelivery would not help.
    void dispatchWebhookEvent(eventType, installationId, organizationId, githubService, prCacheService, payload).catch(
        (error) => {
            // undici's `fetch failed` puts the real reason (DNS / ECONNREFUSED / etc) in .cause.
            const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
            const causeMessage = cause instanceof Error ? cause.message : cause != null ? String(cause) : undefined;
            logger.fatal("Error processing GitHub webhook", error, { event, deliveryId, cause: causeMessage });
        },
    );

    return ctx.json({ ok: true });
});

async function dispatchWebhookEvent(
    type: GitHubWebhookEventType,
    installationId: number,
    organizationId: string,
    githubService: GitHubInstallationService,
    prCacheService: PullRequestCacheService,
    payload: Record<string, unknown>,
): Promise<void> {
    switch (type) {
        case "installation_created":
            // Installation is persisted via the OAuth callback (which has org context).
            // The webhook fires too — we only log it here.
            logger.info("installation.created webhook (installation row handled via callback)", { installationId });
            return;
        case "installation_deleted":
            await githubService.handleUninstall(installationId);
            return;
        case "installation_suspend":
            await githubService.handleSuspend(installationId);
            return;
        case "pull_request_opened":
            await prCacheService.updateFromWebhook(organizationId, payload);
            await startPullRequestDeploy("opened", organizationId, payload);
            return;
        case "pull_request_synchronize":
            await prCacheService.updateFromWebhook(organizationId, payload);
            await startPullRequestDeploy("synchronize", organizationId, payload);
            return;
        case "pull_request_reopened":
            await prCacheService.updateFromWebhook(organizationId, payload);
            await startPullRequestDeploy("reopened", organizationId, payload);
            return;
        case "pull_request_ready_for_review":
            // A draft marked ready for review is no longer a draft, so the
            // draft gate in deployFromWebhook lets it through and the preview
            // builds even for orgs that skip draft PRs.
            await prCacheService.updateFromWebhook(organizationId, payload);
            await startPullRequestDeploy("ready_for_review", organizationId, payload);
            return;
        case "pull_request_closed":
            await prCacheService.updateFromWebhook(organizationId, payload);
            await startPullRequestTeardown(organizationId, payload);
            return;
        case "push":
            await startMainBranchPushDeploy(organizationId, payload);
            return;
        default:
            return;
    }
}

function isWebhookEventKey(key: string): key is keyof typeof WEBHOOK_EVENT_TYPES {
    return Object.hasOwn(WEBHOOK_EVENT_TYPES, key);
}

/**
 * Deploy path for pull_request opened/synchronize/reopened: starts the deploy
 * workflow directly. Silently skipped when previews are disabled (dev /
 * self-host without preview infrastructure).
 */
async function startPullRequestDeploy(
    action: PreviewDeployAction,
    organizationId: string,
    payload: Record<string, unknown>,
): Promise<void> {
    if (!env.PREVIEWKIT_ENABLED) {
        logger.info("Skipping preview deploy: PREVIEWKIT_ENABLED is off", { action, organizationId });
        return;
    }
    await previewkitTriggerService.deployFromWebhook(action, organizationId, payload);
}

/** Teardown path for pull_request.closed; same previews-enabled gate as the deploy path. */
async function startPullRequestTeardown(organizationId: string, payload: Record<string, unknown>): Promise<void> {
    if (!env.PREVIEWKIT_ENABLED) {
        logger.info("Skipping preview teardown: PREVIEWKIT_ENABLED is off", { organizationId });
        return;
    }
    await previewkitTriggerService.teardownFromWebhook(organizationId, payload);
}

/** Pre-record relevance check for push: is there a live main-branch environment tracking the pushed branch? */
async function pushUpdatesMainBranchPreview(
    organizationId: string,
    payload: Record<string, unknown>,
): Promise<boolean> {
    if (!env.PREVIEWKIT_ENABLED) return false;
    return await previewkitTriggerService.pushTargetsMainBranchEnvironment(organizationId, payload);
}

/**
 * Deploy path for push: redeploys the main-branch preview environment at the
 * pushed head, the same way `synchronize` updates a PR environment.
 */
async function startMainBranchPushDeploy(organizationId: string, payload: Record<string, unknown>): Promise<void> {
    if (!env.PREVIEWKIT_ENABLED) {
        logger.info("Skipping main-branch push deploy: PREVIEWKIT_ENABLED is off", { organizationId });
        return;
    }
    await previewkitTriggerService.deployMainBranchFromPushWebhook(organizationId, payload);
}
