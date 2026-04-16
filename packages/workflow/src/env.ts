import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
    server: {
        TEMPORAL_ADDRESS: z.string().min(1).default("localhost:7233"),
        TEMPORAL_NAMESPACE: z.string().min(1).default("default"),
        NAMESPACE: z.string().min(1).default("development"),
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
    skipValidation: process.env.TESTING === "true",
});
