import { base64PrivateKey } from "@autonoma/github/schemas";
import { env as loggerEnv } from "@autonoma/logger/env";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
    extends: [loggerEnv],
    server: {
        DATABASE_URL: z.string().min(1),
        API_URL: z.string().optional(),
        APP_URL: z.string().optional(),
        ENGINE_BILLING_SECRET: z.string().optional(),
        STRIPE_ENABLED: z.stringbool().default(false),
        GITHUB_APP_ID: z.string().min(1).optional(),
        GITHUB_APP_PRIVATE_KEY: base64PrivateKey.optional(),
        GITHUB_APP_WEBHOOK_SECRET: z.string().min(1).optional(),
        GITHUB_APP_SLUG: z.string().min(1).optional(),
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
});
