import type Stripe from "stripe";
import { registerStepFunction } from "workflow/internal/private";

/**
 * Durable workflow entrypoint for Stripe webhooks.
 */
export async function stripeWebhookWorkflow(input: StripeWebhookWorkflowInput): Promise<void> {
    "use workflow";

    await processStripeWebhookEventStep(input);
}

export type StripeWebhookWorkflowInput = {
    event: Stripe.Event;
    processUrl: string;
};

const PROCESS_STRIPE_WEBHOOK_EVENT_STEP_ID =
    "step//./src/workflows/stripe-webhook.workflow//processStripeWebhookEventStep";

export async function processStripeWebhookEventStep(input: StripeWebhookWorkflowInput): Promise<void> {
    "use step";

    const processSecret = process.env.STRIPE_INTERNAL_WEBHOOK_SECRET;
    if (processSecret == null) {
        throw new Error("STRIPE_INTERNAL_WEBHOOK_SECRET is required to process Stripe webhook workflow steps");
    }

    const response = await fetch(input.processUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${processSecret}`,
        },
        body: JSON.stringify({ event: input.event }),
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Failed processing Stripe webhook in internal API (${response.status}): ${body}`);
    }
}

registerStepFunction(PROCESS_STRIPE_WEBHOOK_EVENT_STEP_ID, processStripeWebhookEventStep);
