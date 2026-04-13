import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";
import { env } from "./env";

export const jobEnv = createEnv({
    extends: [env],
    server: {
        BRANCH_ID: z.string().min(1),
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
});
