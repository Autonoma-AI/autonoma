import { requireApiKey, type UserAuthVariables } from "@autonoma/auth";
import { db } from "@autonoma/db";
import { BadRequestError, NotFoundError } from "@autonoma/errors";
import { logger } from "@autonoma/logger";
import {
    CreateSetupBodySchema,
    SetupEventBodySchema,
    UpdateSetupBodySchema,
    UploadArtifactsBodySchema,
    UploadScenarioRecipeVersionsBodySchema,
} from "@autonoma/types";
import * as Sentry from "@sentry/node";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { encryptionHelper, generationProvider, scenarioManager } from "../context";
import { OnboardingManager } from "../routes/onboarding/onboarding-manager";
import { ApplicationSetupService } from "./application-setup.service";

export const applicationSetupHttpRouter = new Hono<{ Variables: UserAuthVariables }>();

// CORS first (preflight needs to succeed before auth), then auth gates
// every actual request. Both apply to all routes in this router.
applicationSetupHttpRouter.use("*", cors({ origin: "*" }));
applicationSetupHttpRouter.use("*", requireApiKey({ db }));

const onboardingManager = new OnboardingManager(db, generationProvider, scenarioManager, encryptionHelper);
const service = new ApplicationSetupService(db, generationProvider, onboardingManager, scenarioManager);

applicationSetupHttpRouter.post("/setups", async (c) => {
    const { userId, organizationId } = c.var.user;

    const parsed = CreateSetupBodySchema.safeParse(await c.req.json());
    if (!parsed.success) {
        return c.json({ error: "Invalid request body", details: parsed.error.flatten() }, 400);
    }

    try {
        const result = await service.createSetup(
            userId,
            organizationId,
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
    const { organizationId } = c.var.user;

    const parsed = SetupEventBodySchema.safeParse(await c.req.json());
    if (!parsed.success) {
        return c.json({ error: "Invalid request body", details: parsed.error.flatten() }, 400);
    }

    try {
        await service.addEvent(c.req.param("id"), organizationId, parsed.data);
        return c.json({ ok: true });
    } catch (err) {
        Sentry.captureException(err);
        logger.error("Failed to add setup event", { err });
        return c.json({ error: "Failed to add event" }, 500);
    }
});

applicationSetupHttpRouter.post("/setups/:id/scenario-recipe-versions", async (c) => {
    const { organizationId } = c.var.user;

    const parsed = UploadScenarioRecipeVersionsBodySchema.safeParse(await c.req.json());
    if (!parsed.success) {
        return c.json({ error: "Invalid request body", details: parsed.error.flatten() }, 400);
    }

    try {
        const result = await service.uploadScenarioRecipeVersions(c.req.param("id"), organizationId, parsed.data);
        return c.json(result);
    } catch (err) {
        if (err instanceof NotFoundError) {
            return c.json({ error: err.message }, 404);
        }
        if (err instanceof BadRequestError) {
            return c.json({ error: err.message }, 400);
        }
        Sentry.captureException(err);
        logger.error("Failed to upload scenario recipe versions", { err });
        return c.json({ error: "Failed to upload scenario recipe versions" }, 500);
    }
});

applicationSetupHttpRouter.get("/setups/:id/scenarios", async (c) => {
    const { organizationId } = c.var.user;
    try {
        const result = await service.listScenariosForSetup(c.req.param("id"), organizationId);
        return c.json(result);
    } catch (err) {
        if (err instanceof NotFoundError) {
            return c.json({ error: err.message }, 404);
        }
        Sentry.captureException(err);
        logger.error("Failed to list scenarios for setup", { err });
        return c.json({ error: "Failed to list scenarios" }, 500);
    }
});

applicationSetupHttpRouter.get("/applications/:id/scenarios", async (c) => {
    const { organizationId } = c.var.user;
    try {
        const result = await service.listScenariosForApplication(c.req.param("id"), organizationId);
        return c.json(result);
    } catch (err) {
        if (err instanceof NotFoundError) {
            return c.json({ error: err.message }, 404);
        }
        Sentry.captureException(err);
        logger.error("Failed to list scenarios for application", { err });
        return c.json({ error: "Failed to list scenarios" }, 500);
    }
});

applicationSetupHttpRouter.get("/applications/:id/test-suite", async (c) => {
    const { organizationId } = c.var.user;
    try {
        const result = await service.getTestSuiteForApplication(c.req.param("id"), organizationId);
        return c.json(result);
    } catch (err) {
        if (err instanceof NotFoundError) {
            return c.json({ error: err.message }, 404);
        }
        Sentry.captureException(err);
        logger.error("Failed to get test suite for application", { err });
        return c.json({ error: "Failed to get test suite" }, 500);
    }
});

applicationSetupHttpRouter.post("/setups/:id/artifacts", async (c) => {
    const { organizationId } = c.var.user;

    const parsed = UploadArtifactsBodySchema.safeParse(await c.req.json());
    if (!parsed.success) {
        return c.json({ error: "Invalid request body", details: parsed.error.flatten() }, 400);
    }

    try {
        await service.uploadArtifacts(c.req.param("id"), organizationId, parsed.data);
        return c.json({ ok: true });
    } catch (err) {
        if (err instanceof NotFoundError) {
            return c.json({ error: err.message }, 404);
        }
        if (err instanceof BadRequestError) {
            return c.json({ error: err.message }, 400);
        }
        Sentry.captureException(err);
        logger.error("Failed to upload artifacts", { err });
        return c.json({ error: "Failed to upload artifacts" }, 500);
    }
});

applicationSetupHttpRouter.patch("/setups/:id", async (c) => {
    const { organizationId } = c.var.user;

    const parsed = UpdateSetupBodySchema.safeParse(await c.req.json());
    if (!parsed.success) {
        return c.json({ error: "Invalid request body", details: parsed.error.flatten() }, 400);
    }

    try {
        await service.updateSetup(c.req.param("id"), organizationId, parsed.data);
        return c.json({ ok: true });
    } catch (err) {
        Sentry.captureException(err);
        logger.error("Failed to update application setup", { err });
        return c.json({ error: "Failed to update setup" }, 500);
    }
});
