import { env as loggerEnv } from "@autonoma/logger/env";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
    extends: [loggerEnv],
    server: {
        SENTRY_DSN_WORKER_GENERAL: z.string().optional(),
        SCENARIO_ENCRYPTION_KEY: z.string().min(1),
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
});

export function getScenarioEncryptionKey(): string {
    return env.SCENARIO_ENCRYPTION_KEY;
}
