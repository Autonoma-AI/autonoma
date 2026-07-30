import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
    server: {
        S3_BUCKET: z.string().min(1),
        S3_REGION: z.string().min(1),
        // Optional so a host can leave credential resolution to the SDK's default chain instead: in
        // EKS the pod assumes its ServiceAccount's role (IRSA), locally these come from .env. Both
        // or neither - one without the other is treated as absent.
        S3_ACCESS_KEY_ID: z.string().min(1).optional(),
        S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
    skipValidation: process.env.TESTING === "true",
});
