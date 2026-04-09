import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
    server: {
        STRIPE_ENABLED: z.stringbool().default(false),
        STRIPE_SECRET_KEY: z.string().min(1).optional(),
        STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
        STRIPE_SUBSCRIPTION_PRICE_ID: z.string().min(1).optional(),
        STRIPE_TOPUP_PRICE_ID: z.string().min(1).optional(),
        BILLING_GRACE_PERIOD_DAYS: z.coerce.number().int().min(0).default(3),
        APP_URL: z.string().optional().default("http://localhost:3000"),
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
    skipValidation: process.env.TESTING === "true",
});
