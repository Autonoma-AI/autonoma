import { env as dbEnv } from "@autonoma/db/env";
import { env as loggerEnv } from "@autonoma/logger/env";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
    extends: [loggerEnv, dbEnv],
    server: {
        VERCEL_ENCRYPTION_KEY: z.string().length(64),
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
    skipValidation: process.env.TESTING === "true",
});
