import { env as loggerEnv } from "@autonoma/logger/env";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
    extends: [loggerEnv],
    server: {
        BRANCH_ID: z.string().min(1),
        GEMINI_API_KEY: z.string().min(1),
        GROQ_KEY: z.string().min(1),
        OPENROUTER_API_KEY: z.string().min(1),
        GITHUB_APP_ID: z.string().min(1),
        GITHUB_APP_PRIVATE_KEY: z.string().min(1),
        GITHUB_APP_WEBHOOK_SECRET: z.string().min(1),
        GITHUB_APP_SLUG: z.string().min(1),
        AGENT_VERSION: z.string().optional().default("latest"),
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
});
