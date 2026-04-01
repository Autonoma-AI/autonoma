import { analytics } from "@autonoma/analytics";
import { createSentryConfig } from "@autonoma/logger";
import * as Sentry from "@sentry/node";
import { env } from "./env";

let bootstrapped = false;

export function bootstrapApiRuntime() {
    if (bootstrapped) return;

    Sentry.init(createSentryConfig({ contextType: "service", contextName: "api" }));

    if (env.POSTHOG_KEY != null) {
        analytics.init(env.POSTHOG_KEY, env.POSTHOG_HOST);
    }

    bootstrapped = true;
}
