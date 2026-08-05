import { base64PrivateKey } from "@autonoma/github/schemas";
import { env as previewkitJobsEnv } from "@autonoma/k8s/previewkit-jobs/env";
import { env as loggerEnv } from "@autonoma/logger/env";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
    extends: [loggerEnv, previewkitJobsEnv],
    server: {
        SENTRY_DSN_WORKER_GENERAL: z.string().optional(),
        POSTHOG_KEY: z.string().optional(),
        POSTHOG_HOST: z.string().optional().default("https://us.i.posthog.com"),
        SCENARIO_ENCRYPTION_KEY: z.string().min(1),
        GITHUB_APP_ID: z.string().min(1),
        GITHUB_APP_PRIVATE_KEY: base64PrivateKey,
        GITHUB_APP_WEBHOOK_SECRET: z.string().min(1),
        GITHUB_APP_SLUG: z.string().min(1),
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
});

export function getScenarioEncryptionKey(): string {
    return env.SCENARIO_ENCRYPTION_KEY;
}
