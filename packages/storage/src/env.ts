import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
    server: {
        S3_BUCKET: z.string().min(1),
        S3_REGION: z.string().min(1),
        S3_ACCESS_KEY_ID: z.string().min(1),
        S3_SECRET_ACCESS_KEY: z.string().min(1),
        S3_ENDPOINT: z.string().url().optional(),
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
});
