import { env as aiEnv } from "@autonoma/ai/env";
import { env as dbEnv } from "@autonoma/db/env";
import { env as loggerEnv } from "@autonoma/logger/env";
import { env as storageEnv } from "@autonoma/storage/env";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
    extends: [loggerEnv, dbEnv, aiEnv, storageEnv],
    server: {
        REMOTE_BROWSER_URL: z.string().optional(),
        HEADLESS: z.string().optional(),
        PREVIEWKIT_BYPASS_TOKEN_KEY: z.string().min(64).optional(),
        /**
         * Auto-handle native browser dialogs (alert / confirm / prompt) during generation and
         * replay. Defaults to enabled; set to "false" as a kill switch for both.
         */
        NATIVE_DIALOGS_ENABLED: z
            .enum(["true", "false"])
            .optional()
            .transform((value) => value !== "false"),
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
});
