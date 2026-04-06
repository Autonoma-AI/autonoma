import { db } from "@autonoma/db";
import { logger } from "@autonoma/logger";
import {
    CreateSetupBodySchema,
    SetupEventBodySchema,
    UpdateSetupBodySchema,
    UploadArtifactsBodySchema,
} from "@autonoma/types";
import * as Sentry from "@sentry/node";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { encryptionHelper, generationProvider, scenarioManager } from "../context";
import { OnboardingManager } from "../routes/onboarding/onboarding-manager";
import { ApplicationSetupService } from "./application-setup.service";
import { verifyApiKeyAndGetContext } from "./verify-api-key";

export const applicationSetupHttpRouter = new Hono();

applicationSetupHttpRouter.use("*", cors({ origin: "*" }));

const onboardingManager = new OnboardingManager(db, generationProvider, scenarioManager, encryptionHelper);
const service = new ApplicationSetupService(db, generationProvider, onboardingManager);

applicationSetupHttpRouter.post("/setups", async (c) => {
    const apiKeyCtx = await verifyApiKeyAndGetContext(db, c.req.header("authorization"));
    if (apiKeyCtx == null) return c.json({ error: "Unauthorized" }, 401);

    const parsed = CreateSetupBodySchema.safeParse(await c.req.json());
    if (!parsed.success) {
        return c.json({ error: "Invalid request body", details: parsed.error.flatten() }, 400);
    }

    try {
        const result = await service.createSetup(
            apiKeyCtx.userId,
            apiKeyCtx.organizationId,
            parsed.data.applicationId,
            parsed.data.repoName,
        );
        return c.json(result, 201);
    } catch (err) {
        Sentry.captureException(err);
        logger.error("Failed to create application setup", { err });
        return c.json({ error: "Failed to create setup" }, 500);
    }
});

applicationSetupHttpRouter.post("/setups/:id/events", async (c) => {
    const apiKeyCtx = await verifyApiKeyAndGetContext(db, c.req.header("authorization"));
    if (apiKeyCtx == null) return c.json({ error: "Unauthorized" }, 401);

    const parsed = SetupEventBodySchema.safeParse(await c.req.json());
    if (!parsed.success) {
        return c.json({ error: "Invalid request body", details: parsed.error.flatten() }, 400);
    }

    try {
        await service.addEvent(c.req.param("id"), apiKeyCtx.organizationId, parsed.data);
        return c.json({ ok: true });
    } catch (err) {
        Sentry.captureException(err);
        logger.error("Failed to add setup event", { err });
        return c.json({ error: "Failed to add event" }, 500);
    }
});

applicationSetupHttpRouter.post("/setups/:id/artifacts", async (c) => {
    const apiKeyCtx = await verifyApiKeyAndGetContext(db, c.req.header("authorization"));
    if (apiKeyCtx == null) return c.json({ error: "Unauthorized" }, 401);

    const parsed = UploadArtifactsBodySchema.safeParse(await c.req.json());
    if (!parsed.success) {
        return c.json({ error: "Invalid request body", details: parsed.error.flatten() }, 400);
    }

    try {
        await service.uploadArtifacts(c.req.param("id"), apiKeyCtx.organizationId, parsed.data);
        return c.json({ ok: true });
    } catch (err) {
        Sentry.captureException(err);
        logger.error("Failed to upload artifacts", { err });
        return c.json({ error: "Failed to upload artifacts" }, 500);
    }
});

applicationSetupHttpRouter.patch("/setups/:id", async (c) => {
    const apiKeyCtx = await verifyApiKeyAndGetContext(db, c.req.header("authorization"));
    if (apiKeyCtx == null) return c.json({ error: "Unauthorized" }, 401);

    const parsed = UpdateSetupBodySchema.safeParse(await c.req.json());
    if (!parsed.success) {
        return c.json({ error: "Invalid request body", details: parsed.error.flatten() }, 400);
    }

    try {
        await service.updateSetup(c.req.param("id"), apiKeyCtx.organizationId, parsed.data);
        return c.json({ ok: true });
    } catch (err) {
        Sentry.captureException(err);
        logger.error("Failed to update application setup", { err });
        return c.json({ error: "Failed to update setup" }, 500);
    }
});
