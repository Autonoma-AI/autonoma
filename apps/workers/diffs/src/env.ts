import { base64PrivateKey } from "@autonoma/github/schemas";
import { env as loggerEnv } from "@autonoma/logger/env";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
    extends: [loggerEnv],
    server: {
        SENTRY_DSN_WORKER_DIFFS: z.string().optional(),
        GITHUB_APP_ID: z.string().min(1),
        GITHUB_APP_PRIVATE_KEY: base64PrivateKey,
        GITHUB_APP_WEBHOOK_SECRET: z.string().min(1),
        GITHUB_APP_SLUG: z.string().min(1),
        // Merged analysis pipeline (classifier re-homed from the investigation worker). All OPTIONAL so this
        // worker boots unchanged when analysis is off (ANALYSIS_AUTHORITATIVE_ENABLED, gated on the API side);
        // createModelSession throws a clear error if the classifier key is missing when analysis runs.
        // The native-OpenAI classifier key (injected into the model session). The OpenRouter/Gemini/Groq keys are
        // read by @autonoma/ai from its own env (smart-visual runs via OpenRouter).
        OPENAI_API_KEY: z.string().min(1).optional(),
        INVESTIGATION_CLASSIFIER_MODEL: z.string().default("gpt-5.6-luna"),
        // The classifier tool-loop step budget.
        INVESTIGATION_CLASSIFY_MAX_STEPS: z.coerce.number().default(60),
        // Optional Loki base URL for the classifier's get_app_logs tool (e.g. http://loki.autonoma.app:3100).
        LOKI_URL: z.string().optional(),
        // Master switch for the authoritative analysis PR comment. OFF by default so the pipeline can run + promote
        // for a canary org without posting to GitHub until the comment is deliberately turned on.
        ANALYSIS_PR_COMMENT_ENABLED: z.stringbool().default(false),
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
});
