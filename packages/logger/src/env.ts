import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
    server: {
        NODE_ENV: z.enum(["development", "production", "test"]).optional().default("development"),
        SENTRY_DSN: z.string().optional(),
        SENTRY_ENV: z.string().optional().default("production"),
        SENTRY_RELEASE: z.string().optional().default("unknown"),
        DEBUG: z.string().optional(),
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
    skipValidation: process.env.TESTING === "true",
});
