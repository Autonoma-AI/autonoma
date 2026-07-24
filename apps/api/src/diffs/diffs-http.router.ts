import { requireApiKey, requireServiceSecret, type UserAuthVariables } from "@autonoma/auth";
import { db } from "@autonoma/db";
import { BadRequestError, NotFoundError } from "@autonoma/errors";
import { logger as rootLogger } from "@autonoma/logger";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { env } from "../env";
import { diffsTriggerService as service } from "./diffs-service";

const triggerDiffsBodySchema = z.object({
    repo_id: z.number(),
    pr_number: z.number().int().positive().optional(),
    github_ref: z.string().min(1),
    url: z.url(),
    webhook_url: z.url().optional(),
    webhook_headers: z.record(z.string(), z.string()).optional(),
    environment: z.string().optional(),
});

const triggerDiffsInternalBodySchema = z.object({
    organization_id: z.string().min(1),
    repo_id: z.number(),
    pr_number: z.number().int().positive(),
    url: z.url(),
});

// Returned (200) instead of triggering a run when a PreviewKit-managed app hits the external trigger: PreviewKit
// already starts the review after each preview deploy, so a customer's leftover diffs-trigger Action is a no-op.
const PREVIEWKIT_ACTION_DEPRECATED_MESSAGE =
    "This app is managed by Autonoma PreviewKit, which triggers reviews automatically after each preview deploy. " +
    "The Autonoma diffs-trigger GitHub Action is deprecated for PreviewKit apps - this request was ignored, and " +
    "the Action can be removed.";

/** The org's chosen preview mode for the app linked to `repoId`, or undefined when there's no app/onboarding row. */
async function resolvePreviewEnvironmentMode(organizationId: string, repoId: number): Promise<string | undefined> {
    const app = await db.application.findFirst({
        where: { organizationId, githubRepositoryId: repoId },
        select: { onboardingState: { select: { previewEnvironmentMode: true } } },
    });
    return app?.onboardingState?.previewEnvironmentMode ?? undefined;
}

// External path: called by CI/CD pipelines with an API key. CORS opens it
// to any origin (browsers in CI dashboards posting directly); the API key
// itself is the trust anchor.
const externalRouter = new Hono<{ Variables: UserAuthVariables }>()
    .use("*", cors({ origin: "*" }))
    .use("*", requireApiKey({ db }))
    .post("/trigger", async (ctx) => {
        const logger = rootLogger.child({ name: "diffsHttpRouter.trigger" });
        logger.info("Received diffs trigger request");

        const { organizationId } = ctx.var.user;

        const parsed = triggerDiffsBodySchema.safeParse(await ctx.req.json());
        if (!parsed.success) {
            return ctx.json({ error: "Invalid request body", details: z.treeifyError(parsed.error) }, 400);
        }
        const body = parsed.data;

        // Ignore the external trigger for PreviewKit-managed apps: PreviewKit starts the run itself after each
        // preview deploy, so a leftover customer Action would otherwise double-trigger. Return 200 (not an error)
        // so the Action doesn't fail/retry, and tell them it's deprecated.
        if ((await resolvePreviewEnvironmentMode(organizationId, body.repo_id)) === "previewkit") {
            logger.info("Ignoring external diffs trigger for a PreviewKit-managed app", {
                organizationId,
                extra: { repoId: body.repo_id },
            });
            return ctx.json({
                ok: true,
                ignored: true,
                deprecated: true,
                message: PREVIEWKIT_ACTION_DEPRECATED_MESSAGE,
            });
        }

        try {
            const result = await service.triggerDiffs({
                organizationId,
                repoId: body.repo_id,
                prNumber: body.pr_number,
                githubRef: body.github_ref,
                url: body.url,
                webhookUrl: body.webhook_url,
                webhookHeaders: body.webhook_headers,
                environment: body.environment,
            });

            return ctx.json({ ok: true, ...result });
        } catch (error) {
            if (error instanceof BadRequestError) {
                return ctx.json({ error: error.message }, 400);
            }
            if (error instanceof NotFoundError) {
                return ctx.json({ error: error.message }, 404);
            }

            logger.fatal("Failed to trigger diffs analysis", error, {
                repoId: body.repo_id,
                prNumber: body.pr_number,
                githubRef: body.github_ref,
            });
            return ctx.json({ error: "Failed to trigger diffs analysis" }, 500);
        }
    });

// Internal path: called by Previewkit after deploy. Service-secret only -
// no user, the organizationId comes from the request body. Mounted on a
// sibling Hono instance so the auth middleware applies cleanly without
// fighting the external router's CORS / API-key wiring.
const internalRouter = new Hono()
    .use("*", requireServiceSecret({ secret: env.PREVIEWKIT_SERVICE_SECRET }))
    .post("/trigger", async (ctx) => {
        const logger = rootLogger.child({ name: "diffsHttpRouter.internalTrigger" });
        logger.info("Received internal diffs trigger request");

        const parsed = triggerDiffsInternalBodySchema.safeParse(await ctx.req.json());
        if (!parsed.success) {
            return ctx.json({ error: "Invalid request body", details: z.treeifyError(parsed.error) }, 400);
        }
        const body = parsed.data;

        try {
            await service.triggerPrDiffs({
                organizationId: body.organization_id,
                repoId: body.repo_id,
                prNumber: body.pr_number,
                url: body.url,
            });

            return ctx.json({ ok: true });
        } catch (error) {
            if (error instanceof BadRequestError) {
                return ctx.json({ error: error.message }, 400);
            }
            if (error instanceof NotFoundError) {
                return ctx.json({ error: error.message }, 404);
            }

            logger.error("Failed to trigger diffs analysis from internal call", error, {
                organizationId: body.organization_id,
                repoId: body.repo_id,
                prNumber: body.pr_number,
            });
            return ctx.json({ error: "Failed to trigger diffs analysis" }, 500);
        }
    });

export const diffsHttpRouter = new Hono().route("/", externalRouter).route("/internal", internalRouter);
