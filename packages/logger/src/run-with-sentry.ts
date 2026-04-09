import * as Sentry from "@sentry/node";
import { createSentryConfig } from "./sentry-config";

export interface RunWithSentryOptions {
    name: string;
    tags?: Record<string, string>;
    dsn?: string;
}

export async function runWithSentry(
    { name, tags = {}, dsn }: RunWithSentryOptions,
    job: (scope: Sentry.Scope) => Promise<void>,
): Promise<never> {
    const sentryConfig = createSentryConfig(
        {
            tags: { package: name, service: name },
            contextType: name,
            contextName: name,
        },
        dsn,
    );
    Sentry.init(sentryConfig);

    try {
        await Sentry.withScope(async (scope) => {
            for (const [key, value] of Object.entries(tags)) scope.setTag(key, value);

            await job(scope);
        });
        await Sentry.flush(2000);
        process.exit(0);
    } catch (error) {
        console.error("[FATAL] Job failed with error:", error);
        Sentry.captureException(error);
        await Sentry.flush(2000);
        process.exit(1);
    }
}
