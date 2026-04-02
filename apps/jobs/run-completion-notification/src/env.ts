import { env as loggerEnv } from "@autonoma/logger/env";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
    extends: [loggerEnv],
    server: {
        DATABASE_URL: z.string().min(1),
        API_URL: z.string().optional(),
        ENGINE_BILLING_SECRET: z.string().optional(),
        STRIPE_ENABLED: z.stringbool().default(false),
        APP_URL: z.string().optional().default("http://localhost:3000"),
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
});
