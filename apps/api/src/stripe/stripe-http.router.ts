import { createBillingServices, getStripe, processWebhookEvent } from "@autonoma/billing";
import { db } from "@autonoma/db";
import { logger } from "@autonoma/logger";
import { BILLING_STRIPE_WEBHOOK_EVENT_TYPES, type BillingStripeWebhookEventType } from "@autonoma/types";
import { Hono } from "hono";
import type Stripe from "stripe";
import { z } from "zod";
import { env } from "../env.ts";
import { dispatchStripeWebhookEvent } from "./stripe-webhook-dispatcher.ts";

export const stripeHttpRouter = new Hono();

const runFailedSchema = z.object({
    generationId: z.string(),
});

const processWebhookSchema = z.object({
    event: z
        .object({
            id: z.string(),
            type: z.string(),
            data: z.object({ object: z.unknown() }),
        })
        .passthrough(),
});
const handledWebhookEventTypes = new Set<BillingStripeWebhookEventType>(BILLING_STRIPE_WEBHOOK_EVENT_TYPES);

stripeHttpRouter.post("/webhook", async (c) => {
    if (env.STRIPE_WEBHOOK_SECRET == null) {
        logger.warn("Stripe webhook received but STRIPE_WEBHOOK_SECRET not configured");
        return c.json({ ok: true });
    }

    const body = await c.req.text();
    const sig = c.req.header("stripe-signature") ?? "";

    let event: Stripe.Event;
    try {
        const stripe = getStripe();
        event = stripe.webhooks.constructEvent(body, sig, env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        logger.warn("Invalid Stripe webhook signature", { err });
        return c.json({ error: "Invalid signature" }, 400);
    }

    if (!handledWebhookEventTypes.has(event.type as BillingStripeWebhookEventType)) {
        logger.info("Ignoring unsupported Stripe webhook event type", { eventType: event.type, eventId: event.id });
        return c.json({ ok: true });
    }

    try {
        await dispatchStripeWebhookEvent(event);
    } catch (err) {
        logger.fatal("Error dispatching Stripe webhook event", {
            eventType: event.type,
            eventId: event.id,
            dispatchMode: env.STRIPE_WEBHOOK_DISPATCH_MODE,
            err,
        });
        return c.json({ error: "Failed to dispatch webhook event" }, 500);
    }

    return c.json({ ok: true });
});

stripeHttpRouter.post("/process-webhook", async (c) => {
    if (env.STRIPE_INTERNAL_WEBHOOK_SECRET == null) {
        logger.warn("Process-webhook received but STRIPE_INTERNAL_WEBHOOK_SECRET not configured");
        return c.json({ error: "Not configured" }, 500);
    }

    const authHeader = c.req.header("authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "");

    if (token !== env.STRIPE_INTERNAL_WEBHOOK_SECRET) {
        logger.warn("Unauthorized request to /v1/stripe/process-webhook");
        return c.json({ error: "Unauthorized" }, 401);
    }

    const parsed = processWebhookSchema.safeParse(await c.req.json());
    if (!parsed.success) {
        return c.json({ error: "Invalid request body", details: parsed.error.flatten() }, 400);
    }

    const event = parsed.data.event as unknown as Stripe.Event;

    try {
        await processWebhookEvent(event);
    } catch (err) {
        logger.fatal("Failed to process Stripe webhook event from internal route", {
            stripe_event_type: event.type,
            stripe_event_id: event.id,
            eventType: event.type,
            eventId: event.id,
            err,
        });
        return c.json({ error: "Failed to process webhook event" }, 500);
    }

    return c.json({ ok: true });
});

stripeHttpRouter.post("/run-failed", async (c) => {
    if (env.ENGINE_BILLING_SECRET == null) {
        logger.warn("Run-failed received but ENGINE_BILLING_SECRET not configured");
        return c.json({ ok: true });
    }

    const authHeader = c.req.header("authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "");

    if (token !== env.ENGINE_BILLING_SECRET) {
        logger.warn("Unauthorized request to /v1/stripe/run-failed");
        return c.json({ error: "Unauthorized" }, 401);
    }

    const parsed = runFailedSchema.safeParse(await c.req.json());
    if (!parsed.success) {
        return c.json({ error: "Invalid request body", details: parsed.error.flatten() }, 400);
    }

    const { generationId } = parsed.data;
    const { billingService } = createBillingServices(db);

    try {
        await billingService.refundCreditsForGeneration(generationId);
    } catch (err) {
        logger.fatal("Failed to refund credits for generation", {
            generationId,
            source: "run-failed-endpoint",
            route: "/v1/stripe/run-failed",
            err,
        });
        return c.json({ error: "Failed to process billing refund" }, 500);
    }

    return c.json({ ok: true });
});
