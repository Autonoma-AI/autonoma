import { processWebhookEvent } from "@autonoma/billing";
import { logger } from "@autonoma/logger";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type Stripe from "stripe";
import { env } from "../env.ts";

const sqsClient = new SQSClient({
    region: env.AWS_REGION,
    credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
});

async function dispatchWithSqs(event: Stripe.Event): Promise<void> {
    const result = await sqsClient.send(
        new SendMessageCommand({
            QueueUrl: env.STRIPE_WEBHOOK_SQS_QUEUE_URL,
            MessageBody: JSON.stringify({ event }),
        }),
    );

    logger.info("Stripe webhook event queued in SQS", {
        eventId: event.id,
        eventType: event.type,
        messageId: result.MessageId,
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
    if (env.STRIPE_WEBHOOK_DISPATCH_MODE === "sqs") {
        await dispatchWithSqs(event);
        return;
    }

    dispatchDirect(event);
}
