import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";
import { env as sharedEnv } from "./env";

/** Shared by both Vercel jobs, and by neither of the others - hence not in the base schema. */
export const env = createEnv({
    extends: [sharedEnv],
    server: {
        VERCEL_ENCRYPTION_KEY: z.string().length(64),
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
    skipValidation: process.env.TESTING === "true",
});
