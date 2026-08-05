import { env as dbEnv } from "@autonoma/db/env";
import { env as loggerEnv } from "@autonoma/logger/env";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";
import { env as k8sEnv } from "../env";

/** A process that never launches a Job still needs `NAMESPACE` set - e.g. `NAMESPACE=local`. */
export const env = createEnv({
    extends: [k8sEnv, dbEnv, loggerEnv],
    server: {
        /** Optional: an environment reading secrets from AWS Secrets Manager has no CMK. */
        PREVIEWKIT_SECRETS_CMK: z.string().min(1).optional(),
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
    skipValidation: process.env.TESTING === "true",
});
