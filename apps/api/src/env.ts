import { env as billingEnv } from "@autonoma/billing/env";
import { env as dbEnv } from "@autonoma/db/env";
import { env as loggerEnv } from "@autonoma/logger/env";
import { env as storageEnv } from "@autonoma/storage/env";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
    extends: [loggerEnv, dbEnv, storageEnv, billingEnv],
    server: {
        API_PORT: z.string(),
        INTERNAL_DOMAIN: z.string().optional().default("autonoma.app"),
        ALLOWED_ORIGINS: z.string().optional().default("http://localhost:3000"),
        SCENARIO_ENCRYPTION_KEY: z.string().min(1),
        GOOGLE_CLIENT_ID: z.string().min(1),
        GOOGLE_CLIENT_SECRET: z.string().min(1),
        AGENT_VERSION: z.string().optional().default("latest"),
        POSTHOG_KEY: z.string().optional(),
        POSTHOG_HOST: z.string().optional().default("https://us.i.posthog.com"),
        GEMINI_API_KEY: z.string().min(1),
        REDIS_URL: z.string().min(1),
        LOCAL_GENERATION: z.stringbool().default(false),
        LOCAL_GENERATION_CONCURRENCY: z.coerce.number().int().positive().default(2),
        // Used to indicate that we're running in a test environment.
        // This is only intended to avoid importing certain modules, do not use it for any other purpose.
        TESTING: z.stringbool().default(false),
        ENGINE_BILLING_SECRET: z.string().min(1).optional(),
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
});
