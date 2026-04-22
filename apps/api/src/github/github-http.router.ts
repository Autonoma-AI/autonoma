import { db } from "@autonoma/db";
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
                await githubService.handleUninstall(installation.id);
            } else if (action === "suspend") {
                await githubService.handleSuspend(installation.id);
            }
        }
    } catch (error) {
        logger.fatal("Error processing GitHub webhook", error, { event });
    }

    return ctx.json({ ok: true });
});
