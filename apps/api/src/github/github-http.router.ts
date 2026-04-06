import { db } from "@autonoma/db";
import { GitHubApp } from "@autonoma/github";
import { logger } from "@autonoma/logger";
import { CommitDiffHandler } from "@autonoma/test-updates";
import { triggerDiffsJob } from "@autonoma/workflow";
import * as Sentry from "@sentry/node";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { verifyApiKeyAndGetContext } from "../application-setup/verify-api-key";
import { env } from "../env";
import { GitHubInstallationService } from "./github-installation.service";
import { verifyInstallState } from "./github-state";
import { GitHubWebhookHandler } from "./github-webhook.handler";

type GitHubEnv = {
    Variables: {
        githubApp: GitHubApp;
        githubService: GitHubInstallationService;
    };
};

const deploymentBodySchema = z.object({
    repo_full_name: z.string(),
    sha: z.string(),
    base_sha: z.string().optional(),
    environment: z.string(),
    url: z.string().optional(),
});

export const githubHttpRouter = new Hono<GitHubEnv>();

githubHttpRouter.use("*", cors({ origin: "*" }));

githubHttpRouter.use("*", async (ctx, next) => {
    const githubApp = new GitHubApp({
        appId: env.GITHUB_APP_ID,
        privateKey: env.GITHUB_APP_PRIVATE_KEY,
        webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET,
        appSlug: env.GITHUB_APP_SLUG,
    });

    ctx.set("githubApp", githubApp);
    ctx.set("githubService", new GitHubInstallationService(db, githubApp));
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
        return ctx.redirect(`${errorBase}?error=install_failed`);
    }

    const successBase = returnPath != null ? `${appUrl}${returnPath}` : appUrl;
    return ctx.redirect(`${successBase}?connected=true`);
});

githubHttpRouter.post("/deployment", async (ctx) => {
    const rawKey = ctx.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (rawKey == null) return ctx.json({ error: "Unauthorized" }, 401);

    const apiKeyCtx = await verifyApiKeyAndGetContext(db, ctx.req.header("authorization"));
    if (apiKeyCtx == null) {
        return ctx.json({ error: "Unauthorized" }, 401);
    }

    const parsed = deploymentBodySchema.safeParse(await ctx.req.json());
    if (!parsed.success) {
        return ctx.json({ error: "Invalid request body", details: parsed.error.flatten() }, 400);
    }
    const body = parsed.data;

    const userId = apiKeyCtx.userId;
    const member = await db.member.findFirst({ where: { userId }, select: { organizationId: true } });
    if (member == null) return ctx.json({ error: "No organization for this API key" }, 403);

    const { githubService } = ctx.var;

    try {
        await githubService.handleDeploymentNotification(
            member.organizationId,
            body.repo_full_name,
            body.sha,
            body.base_sha,
            body.environment,
            body.url,
        );
    } catch (error) {
        logger.fatal("Failed to handle deployment notification", error, {
            repoFullName: body.repo_full_name,
            sha: body.sha,
            environment: body.environment,
        });
        return ctx.json({ error: "Failed to process deployment" }, 500);
    }

    return ctx.json({ ok: true });
});

githubHttpRouter.post("/webhook", async (ctx) => {
    const body = await ctx.req.text();
    const signature = ctx.req.header("x-hub-signature-256") ?? "";
    const event = ctx.req.header("x-github-event") ?? "";

    const { githubApp, githubService } = ctx.var;

    const isValid = await githubApp.verifyWebhook(body, signature);
    if (!isValid) {
        logger.warn("Invalid GitHub webhook signature");
        return ctx.json({ error: "Invalid signature" }, 401);
    }

    const commitDiffHandler = new CommitDiffHandler(db, githubApp, triggerDiffsJob);
    const webhookHandler = new GitHubWebhookHandler(githubService, db, commitDiffHandler);

    try {
        const payload = JSON.parse(body) as Record<string, unknown>;

        if (event === "installation") {
            const action = payload.action as string;
            const installation = payload.installation as {
                id: number;
                account?: { login?: string; id?: number; type?: string };
            };

            if (action === "created") {
                // Installation is created via the callback URL (which has session context).
                // The webhook fires too but carries no org context, so we ignore it here.
                logger.info("GitHub webhook: installation.created (handled via callback)", {
                    installationId: installation.id,
                    account: installation.account?.login,
                });
            } else if (action === "deleted") {
                await webhookHandler.handleInstallationDeleted(installation.id);
            } else if (action === "suspend") {
                await webhookHandler.handleInstallationSuspended(installation.id);
            }
        } else if (event === "pull_request") {
            const action = payload.action as string;
            const pr = payload.pull_request as { number: number };
            const repo = payload.repository as { full_name: string };
            webhookHandler.handlePullRequest(action, pr.number, repo.full_name);
        } else if (event === "push") {
            const repo = payload.repository as { full_name: string };
            const ref = payload.ref as string;
            const installation = payload.installation as { id: number };
            void webhookHandler.handlePush(repo.full_name, ref, installation.id).catch((err: unknown) => {
                Sentry.captureException(err);
                logger.error("Error handling push webhook", { event, err });
            });
        }
    } catch (error) {
        logger.fatal("Error processing GitHub webhook", error, { event });
    }

    return ctx.json({ ok: true });
});
