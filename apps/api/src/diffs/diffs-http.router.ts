import { db } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import { OctokitGitHubApp } from "@autonoma/github";
import { logger as rootLogger } from "@autonoma/logger";
import { cancelDiffsJob, triggerDiffsJob } from "@autonoma/workflow";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { verifyApiKeyAndGetContext } from "../application-setup/verify-api-key";
import { env } from "../env";
import { GitHubInstallationService } from "../github/github-installation.service";
import { DiffsTriggerService } from "./diffs-trigger.service";

const triggerDiffsBodySchema = z.object({
    repo_id: z.number(),
    pr_number: z.number().int().positive(),
    url: z.url(),
    webhook_url: z.url(),
    webhook_headers: z.record(z.string(), z.string()).optional(),
    environment: z.string().optional(),
});

const githubApp = new OctokitGitHubApp({
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET,
    appSlug: env.GITHUB_APP_SLUG,
});

const githubService = new GitHubInstallationService(db, githubApp);
const service = new DiffsTriggerService(db, githubService, triggerDiffsJob, cancelDiffsJob);

export const diffsHttpRouter = new Hono();

diffsHttpRouter.use("*", cors({ origin: "*" }));

diffsHttpRouter.post("/trigger", async (ctx) => {
    const logger = rootLogger.child({ name: "diffsHttpRouter.trigger" });
    logger.info("Received diffs trigger request");

    const apiKeyCtx = await verifyApiKeyAndGetContext(db, ctx.req.header("authorization"));
    if (apiKeyCtx == null) {
        return ctx.json({ error: "Unauthorized" }, 401);
    }

    const parsed = triggerDiffsBodySchema.safeParse(await ctx.req.json());
    if (!parsed.success) {
        return ctx.json({ error: "Invalid request body", details: z.treeifyError(parsed.error) }, 400);
    }
    const body = parsed.data;

    try {
        const result = await service.triggerDiffs({
            organizationId: apiKeyCtx.organizationId,
            repoId: body.repo_id,
            prNumber: body.pr_number,
            url: body.url,
            webhookUrl: body.webhook_url,
            webhookHeaders: body.webhook_headers,
            environment: body.environment,
        });

        return ctx.json({ ok: true, ...result });
    } catch (error) {
        if (error instanceof NotFoundError) {
            return ctx.json({ error: error.message }, 404);
        }

        logger.fatal("Failed to trigger diffs analysis", error, {
            repoId: body.repo_id,
            prNumber: body.pr_number,
        });
        return ctx.json({ error: "Failed to trigger diffs analysis" }, 500);
    }
});
