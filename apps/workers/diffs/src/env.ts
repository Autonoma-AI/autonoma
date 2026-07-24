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
        // Pipeline gates for the PreviewKit-triggered PR run (`prepareDiffsRun` activity), which reuses the API's
        // per-org analysis-vs-diffs logic. MUST be set to the same values as the API so the PreviewKit path picks
        // the same pipeline: ANALYSIS_AUTHORITATIVE_ENABLED is the global analysis master switch (else diffs);
        // INVESTIGATION_SHADOW_ENABLED gates the diffs fallback's investigation shadow.
        ANALYSIS_AUTHORITATIVE_ENABLED: z.stringbool().default(false),
        INVESTIGATION_SHADOW_ENABLED: z.stringbool().default(false),
        // Global master kill-switch for the Autonoma merge gate. OFF by default: while off, the finalize seam never
        // posts a verdict conclusion no matter an org's per-org `mergeGateEnabled`. Effective gate =
        // MERGE_GATE_ENABLED && org.mergeGateEnabled (&& analysisEnabled, enforced at enable time).
        MERGE_GATE_ENABLED: z.stringbool().default(false),
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
    // Tests import modules that transitively load this env (e.g. the analysis activities pull in `services`);
    // skip validation under TESTING so importing them never trips required-var checks, matching @autonoma/db and
    // @autonoma/logger. Activities that actually need a key (createModelSession) still throw at call time.
    skipValidation: process.env.TESTING === "true",
});
