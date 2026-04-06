import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
    server: {
        REPOSITORY_ID: z.string().min(1),
        AGENT_VERSION: z.string().optional().default("latest"),
        SENTRY_DSN: z.string().optional(),
        SENTRY_ENV: z.string().optional(),
        APP_URL: z.string().optional(),
        GITHUB_APP_ID: z.string().min(1),
        GITHUB_APP_PRIVATE_KEY: z.string().min(1),
        GITHUB_APP_WEBHOOK_SECRET: z.string().min(1),
        GITHUB_APP_SLUG: z.string().min(1),
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
});
