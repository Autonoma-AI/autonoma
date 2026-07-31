import { base64PrivateKey } from "@autonoma/github/schemas";
import { env as loggerEnv } from "@autonoma/logger/env";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
    extends: [loggerEnv],
    server: {
        SENTRY_DSN_WORKER_DIFFS: z.string().optional(),
        POSTHOG_KEY: z.string().optional(),
        POSTHOG_HOST: z.string().optional().default("https://us.i.posthog.com"),
        GITHUB_APP_ID: z.string().min(1),
        GITHUB_APP_PRIVATE_KEY: base64PrivateKey,
        GITHUB_APP_WEBHOOK_SECRET: z.string().min(1),
        GITHUB_APP_SLUG: z.string().min(1),
        // Merged analysis pipeline (classifier re-homed from the investigation worker). Kept OPTIONAL so a
        // deployment with the analysis kill switch thrown still boots; createModelSession throws a clear error if
        // the classifier key is missing, failing the analysis run rather than the whole worker.
        // The native-OpenAI classifier key (injected into the model session). The OpenRouter/Gemini/Groq keys are
        // read by @autonoma/ai from its own env (smart-visual runs via OpenRouter).
        OPENAI_API_KEY: z.string().min(1).optional(),
        INVESTIGATION_CLASSIFIER_MODEL: z.string().default("gpt-5.6-luna"),
        // The `analyze_video` model, overridable so a bad video model can be reverted (e.g. to
        // google/gemini-3-flash-preview) without a deploy. Must be one of the model session's VIDEO_MODELS.
        INVESTIGATION_VIDEO_MODEL: z.string().default("minimax/minimax-m3"),
        // Optional Loki base URL for the classifier's get_app_logs tool (e.g. http://loki.autonoma.app:3100).
        LOKI_URL: z.string().optional(),
        // Master switch for the authoritative analysis PR comment. ON by default, matching the pipeline it reports
        // on: an analysis run that posts nothing is invisible to the PR author. Set false to keep the pipeline
        // running + promoting while it stops touching GitHub.
        ANALYSIS_PR_COMMENT_ENABLED: z.stringbool().default(true),
        // Global master kill-switch for the Autonoma merge gate. OFF by default: while off, the finalize seam never
        // posts a verdict conclusion no matter an org's per-org `mergeGateEnabled`. Effective gate =
        // MERGE_GATE_ENABLED && org.mergeGateEnabled.
        MERGE_GATE_ENABLED: z.stringbool().default(false),
        // Where previewkit secret VALUES are read from for the database DATABASE_URL points at,
        // and the CMK wrapping their encryption keys. The preview-introspection tools read the
        // env a preview runs with; postgres without a CMK, or an un-migrated repo, falls back to
        // AWS Secrets Manager per repo.
        PREVIEWKIT_SECRETS_READ: z.enum(["aws", "postgres"]).default("aws"),
        PREVIEWKIT_SECRETS_CMK: z.string().min(1).optional(),
        AWS_REGION: z.string().min(1).default("us-east-1"),
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
    // Tests import modules that transitively load this env (e.g. the analysis activities pull in `services`);
    // skip validation under TESTING so importing them never trips required-var checks, matching @autonoma/db and
    // @autonoma/logger. Activities that actually need a key (createModelSession) still throw at call time.
    skipValidation: process.env.TESTING === "true",
});
