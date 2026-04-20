import { env as reviewEnv } from "@autonoma/review/env";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
    extends: [reviewEnv],
    server: {
        SENTRY_DSN_REPLAY_REVIEWER: z.string().optional(),
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
});
