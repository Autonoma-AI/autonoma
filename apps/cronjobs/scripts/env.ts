import { env as dbEnv } from "@autonoma/db/env";
import { env as loggerEnv } from "@autonoma/logger/env";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
    extends: [loggerEnv, dbEnv],
    server: {
        VERCEL_ENCRYPTION_KEY: z.string().length(64),
        // The shared AMP workspace both clusters' metrics live in (deployment/amp/README.md).
        AMP_WORKSPACE_URL: z
            .string()
            .url()
            .default(
                "https://aps-workspaces.us-east-1.amazonaws.com/workspaces/ws-6d0b6fe7-8e6a-441c-b99c-aab8460d5cd6",
            ),
        AMP_REGION: z.string().default("us-east-1"),
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
    skipValidation: process.env.TESTING === "true",
});
