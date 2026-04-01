import { processWebhookEvent } from "@autonoma/billing";
import { logger } from "@autonoma/logger";
import type Stripe from "stripe";
import { env } from "../env.ts";
import { type StripeWebhookWorkflowInput, stripeWebhookWorkflow } from "../workflows/stripe-webhook.workflow.ts";

type WorkflowApi = {
    start: (
        workflow: (input: StripeWebhookWorkflowInput) => Promise<void>,
        args: [StripeWebhookWorkflowInput],
    ) => Promise<unknown>;
};

async function loadWorkflowApi(): Promise<WorkflowApi> {
    const workflowApi = (await import("workflow/api")) as WorkflowApi;
    if (typeof workflowApi.start !== "function") {
        throw new Error("workflow/api.start is not available");
    }
    return workflowApi;
}

async function dispatchWithWorkflow(event: Stripe.Event): Promise<void> {
    const processUrl =
        env.STRIPE_INTERNAL_WEBHOOK_PROCESS_URL ?? `http://localhost:${env.API_PORT}/v1/stripe/process-webhook`;
    const input: StripeWebhookWorkflowInput = {
        event,
        processUrl,
    };

    const workflowApi = await loadWorkflowApi();

    const run = await workflowApi.start(stripeWebhookWorkflow, [input]);

    logger.info("Stripe webhook dispatched to workflow", {
        eventId: event.id,
        eventType: event.type,
        runId: (run as { runId?: string }).runId,
        processUrl,
    });
}

function dispatchDirect(event: Stripe.Event): void {
    void processWebhookEvent(event).catch((error) => {
        logger.fatal("Error processing Stripe webhook event", {
            eventId: event.id,
            eventType: event.type,
            dispatchMode: "direct",
            err: error,
        });
    });
}

export async function dispatchStripeWebhookEvent(event: Stripe.Event): Promise<void> {
    if (env.STRIPE_WEBHOOK_DISPATCH_MODE === "workflow") {
        await dispatchWithWorkflow(event);
        return;
    }

    dispatchDirect(event);
}
