import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
    clientPrefix: "VITE_",
    client: {
        VITE_API_URL: z.url().optional().default("http://localhost:4000"),
        VITE_INTERNAL_DOMAIN: z.string().optional().default("autonoma.app"),
        VITE_TEMPORAL_URL: z.string().optional(),
        VITE_TEMPORAL_NAMESPACE: z.string().optional().default("default"),
        VITE_SENTRY_DSN: z.string().optional(),
        VITE_SENTRY_URL: z.string().optional(),
        VITE_POSTHOG_KEY: z.string().optional(),
    },
    runtimeEnv: import.meta.env,
    emptyStringAsUndefined: true,
});
