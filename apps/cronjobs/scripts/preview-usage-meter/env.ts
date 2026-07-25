import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";
import { env as sharedEnv } from "../env";

/**
 * Kept separate from the shared cronjobs env so only this job has to be given
 * the Prometheus basic-auth credential - the other cronjobs don't query metrics.
 */
export const env = createEnv({
    extends: [sharedEnv],
    server: {
        // Self-hosted Prometheus both clusters remote_write to (deployment/prometheus-agent/README.md).
        PROMETHEUS_URL: z.string().url().default("https://prometheus.autonoma.app:9090"),
        PROMETHEUS_USERNAME: z.string().min(1),
        PROMETHEUS_PASSWORD: z.string().min(1),
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
    skipValidation: process.env.TESTING === "true",
});
