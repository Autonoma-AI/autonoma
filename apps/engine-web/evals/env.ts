import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

/**
 * Eval-only environment variables.
 */
export const env = createEnv({
    server: {
        GEMINI_API_KEY: z.string().min(1),
        SCENARIO_ENCRYPTION_KEY: z.string().min(64).optional(),
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
    skipValidation: process.env["VITEST"] != null,
});
