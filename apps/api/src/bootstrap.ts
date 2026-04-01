import { analytics } from "@autonoma/analytics";
import { createSentryConfig } from "@autonoma/logger";
import * as Sentry from "@sentry/node";
import { env } from "./env";
import { StripeSqsWorker } from "./stripe/stripe-sqs-worker";

let bootstrapped = false;

function validateRuntimeConfig() {
    if (env.STRIPE_ENABLED && env.STRIPE_WEBHOOK_DISPATCH_MODE === "sqs" && env.STRIPE_WEBHOOK_SQS_QUEUE_URL == null) {
        throw new Error("STRIPE_WEBHOOK_SQS_QUEUE_URL is required when STRIPE_WEBHOOK_DISPATCH_MODE=sqs");
    }
}

export function bootstrapApiRuntime() {
    if (bootstrapped) return;

    validateRuntimeConfig();

    Sentry.init(createSentryConfig({ contextType: "service", contextName: "api" }));

    if (env.POSTHOG_KEY != null) {
        analytics.init(env.POSTHOG_KEY, env.POSTHOG_HOST);
    }

    if (env.STRIPE_ENABLED && env.STRIPE_WEBHOOK_DISPATCH_MODE === "sqs" && env.STRIPE_WEBHOOK_SQS_QUEUE_URL != null) {
        const worker = new StripeSqsWorker(
            env.STRIPE_WEBHOOK_SQS_QUEUE_URL,
            env.AWS_REGION,
            env.AWS_ACCESS_KEY_ID,
            env.AWS_SECRET_ACCESS_KEY,
        );
        worker.start();
    }

    bootstrapped = true;
}
