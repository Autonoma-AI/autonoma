import { env as dbEnv } from "@autonoma/db/env";
import { env as loggerEnv } from "@autonoma/logger/env";
import { createEnv } from "@t3-oss/env-core";

/**
 * What every cronjob needs: a database and a logger. Job-specific variables
 * belong in that job's own env module, so a job's manifest only carries the
 * secrets it actually uses.
 */
export const env = createEnv({
    extends: [loggerEnv, dbEnv],
    server: {},
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
    skipValidation: process.env.TESTING === "true",
});
