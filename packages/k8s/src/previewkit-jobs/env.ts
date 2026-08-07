import { env as dbEnv } from "@autonoma/db/env";
import { base64PrivateKey } from "@autonoma/github/schemas";
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
        /**
         * This launcher's OWN GitHub App, overriding the shared `previewkit-env-file` secret's production App for
         * Jobs it launches (see PreviewkitJobLauncherOptions.githubAppId). Optional: an environment with no App of
         * its own (production, which the shared secret already carries) simply launches without the override.
         */
        GITHUB_APP_ID: z.string().min(1).optional(),
        GITHUB_APP_PRIVATE_KEY: base64PrivateKey.optional(),
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
    skipValidation: process.env.TESTING === "true",
});
