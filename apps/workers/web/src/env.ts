import { env as loggerEnv } from "@autonoma/logger/env";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
    extends: [loggerEnv],
    server: {
        SENTRY_DSN_WORKER_WEB: z.string().optional(),
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
});
