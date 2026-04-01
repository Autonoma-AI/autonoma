import type Stripe from "stripe";
import { fetch as workflowFetch } from "workflow";

/**
 * Durable workflow entrypoint for Stripe webhooks.
 */
export async function stripeWebhookWorkflow(input: StripeWebhookWorkflowInput): Promise<void> {
    "use workflow";
    const processSecret = process.env.STRIPE_INTERNAL_WEBHOOK_SECRET;
    if (processSecret == null) {
        throw new Error("STRIPE_INTERNAL_WEBHOOK_SECRET is required to process Stripe webhook workflow steps");
    }

    const response = await workflowFetch(input.processUrl, {
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

export type StripeWebhookWorkflowInput = {
    event: Stripe.Event;
    processUrl: string;
};
