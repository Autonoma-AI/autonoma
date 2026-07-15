import { db } from "@autonoma/db";
import { BadRequestError, ConflictError, NotFoundError } from "@autonoma/errors";
import { logger as rootLogger } from "@autonoma/logger";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { encryptionHelper, getVercelEncryptionHelper, scenarioManager } from "../../context";
import { diffsTriggerService } from "../../diffs/diffs-service";
import { OnboardingManager } from "./onboarding-manager";

const manager = new OnboardingManager(db, scenarioManager, encryptionHelper, {
    diffsTrigger: diffsTriggerService,
    getVercelEncryptionHelper,
});

export const onboardingHttpRouter = new Hono()
    .use("*", cors({ origin: "*" }))
    .post("/deployment-signal", async (ctx) => {
        const logger = rootLogger.child({ name: "onboardingHttpRouter.deploymentSignal" });
        logger.info("Received onboarding deployment signal");

        const bodyText = await ctx.req.text();
        const signature = ctx.req.header("x-signature") ?? "";

        try {
            const result = await manager.acceptDeploymentSignal({ bodyText, signature });
            return ctx.json(result);
        } catch (error) {
            if (error instanceof BadRequestError) {
                return ctx.json({ error: error.message }, 400);
            }
            if (error instanceof NotFoundError) {
                return ctx.json({ error: error.message }, 404);
            }
            if (error instanceof ConflictError) {
                return ctx.json({ error: error.message }, 409);
            }

            logger.error("Failed to accept onboarding deployment signal", {
                error: error instanceof Error ? error.message : String(error),
            });
            return ctx.json({ error: "Failed to accept deployment signal" }, 500);
        }
    });
