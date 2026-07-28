import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
    server: {
        S3_BUCKET: z.string().min(1),
        S3_REGION: z.string().min(1),
        S3_ACCESS_KEY_ID: z.string().min(1),
        S3_SECRET_ACCESS_KEY: z.string().min(1),
        // Custom S3 endpoint (LocalStack, MinIO). Unset against real AWS, where the
        // SDK derives the endpoint from the region.
        S3_ENDPOINT: z.string().url().optional(),
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
    skipValidation: process.env.TESTING === "true",
});
