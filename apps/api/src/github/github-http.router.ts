import { db, type GitHubWebhookEventType } from "@autonoma/db";
import type { GitHubApp } from "@autonoma/github";
import { logger } from "@autonoma/logger";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { env } from "../env";
import { buildGitHubApp } from "./github-app";
import { GitHubInstallationService } from "./github-installation.service";
import { verifyInstallState } from "./github-state";

type GitHubEnv = {
    Variables: {
        githubApp: GitHubApp;
        githubService: GitHubInstallationService;
    };
};

const githubApp = buildGitHubApp(env);
const githubService = new GitHubInstallationService(db, githubApp);

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
} as const satisfies Record<string, GitHubWebhookEventType>;

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
    const eventKey = action != null ? `${event}.${action}` : undefined;
    const eventType = eventKey != null ? WEBHOOK_EVENT_TYPES[eventKey as keyof typeof WEBHOOK_EVENT_TYPES] : undefined;

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

    await githubService.recordWebhookEvent({
        deliveryId,
        type: eventType,
        action,
        installationId,
        organizationId,
        payload,
    });

    let processingError: string | undefined;
    try {
        await dispatchWebhookEvent(eventType, installationId, organizationId, githubService, payload);
    } catch (error) {
        // undici's `fetch failed` puts the real reason (DNS / ECONNREFUSED / etc) in .cause.
        const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
        const causeMessage = cause instanceof Error ? cause.message : cause != null ? String(cause) : undefined;
        processingError = error instanceof Error ? error.message : String(error);
        if (causeMessage != null) processingError = `${processingError}: ${causeMessage}`;
        logger.fatal("Error processing GitHub webhook", error, { event, deliveryId, cause: causeMessage });
    }

    await githubService.markWebhookEventProcessed(deliveryId, processingError);

    return ctx.json({ ok: true });
});

async function dispatchWebhookEvent(
    type: GitHubWebhookEventType,
    installationId: number,
    organizationId: string,
    githubService: GitHubInstallationService,
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
        case "pull_request_synchronize":
        case "pull_request_reopened":
            await forwardPullRequestToPreviewkit("deploy", organizationId, payload);
            return;
        case "pull_request_closed":
            await forwardPullRequestToPreviewkit("teardown", organizationId, payload);
            return;
        default:
            return;
    }
}

interface PullRequestRef {
    sha: string;
    ref: string;
}

interface PullRequestPayload {
    number: number;
    head: PullRequestRef;
    base: PullRequestRef;
}

interface RepositoryPayload {
    id: number;
    full_name: string;
    clone_url: string;
}

async function forwardPullRequestToPreviewkit(
    op: "deploy" | "teardown",
    organizationId: string,
    payload: Record<string, unknown>,
): Promise<void> {
    if (env.PREVIEWKIT_URL == null) {
        logger.info("Skipping Previewkit forward: PREVIEWKIT_URL not configured", { op });
        return;
    }

    const pr = payload.pull_request as PullRequestPayload | undefined;
    const repo = payload.repository as RepositoryPayload | undefined;
    if (pr == null || repo == null) {
        logger.warn("Pull request webhook missing pull_request or repository payload", { op });
        return;
    }

    const base = env.PREVIEWKIT_URL.replace(/\/$/, "");

    if (op === "deploy") {
        const url = `${base}/v1/environments`;
        const body = {
            repoFullName: repo.full_name,
            prNumber: pr.number,
            organizationId,
            githubRepositoryId: repo.id,
            headSha: pr.head.sha,
            headRef: pr.head.ref,
            baseSha: pr.base.sha,
            baseRef: pr.base.ref,
            cloneUrl: repo.clone_url,
        };
        const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`Previewkit deploy returned ${res.status}: ${text}`);
        }
        logger.info("Forwarded PR deploy to Previewkit", { repo: repo.full_name, pr: pr.number });
        return;
    }

    const [owner, name] = repo.full_name.split("/");
    const teardownQuery = new URLSearchParams({
        organizationId,
        githubRepositoryId: String(repo.id),
    });
    const url = `${base}/v1/environments/${owner}/${name}/${pr.number}?${teardownQuery.toString()}`;
    const res = await fetch(url, { method: "DELETE", signal: AbortSignal.timeout(10_000) });
    if (!res.ok && res.status !== 404) {
        const text = await res.text().catch(() => "");
        throw new Error(`Previewkit teardown returned ${res.status}: ${text}`);
    }
    logger.info("Forwarded PR teardown to Previewkit", { repo: repo.full_name, pr: pr.number });
}
