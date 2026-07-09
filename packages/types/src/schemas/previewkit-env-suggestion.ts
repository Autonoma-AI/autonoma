import { z } from "zod";
import { SuggestableServiceRecipeSchema, SuggestionAppRefSchema } from "./previewkit-service-suggestion";

export const SuggestionServiceRefSchema = z.object({
    name: z.string(),
    recipe: SuggestableServiceRecipeSchema,
});

export type SuggestionServiceRef = z.infer<typeof SuggestionServiceRefSchema>;

export const SuggestEnvVarsInputSchema = z.object({
    applicationId: z.string(),
    githubRepositoryId: z.number().int().positive().optional(),
    apps: z.array(SuggestionAppRefSchema),
    services: z.array(SuggestionServiceRefSchema),
});

export type SuggestEnvVarsInput = z.infer<typeof SuggestEnvVarsInputSchema>;

export const SuggestedEnvVarSchema = z.object({
    key: z.string(),
    value: z.string().optional(),
    reference: z.string().optional(),
    sensitive: z.boolean(),
    /**
     * Whether the value must be present during the image BUILD (not just at
     * runtime) - e.g. framework vars inlined into the client bundle
     * (`NEXT_PUBLIC_*`, `VITE_*`) or values read by the build/install command.
     * Maps to the row's "also inject at build time" switch. Omitted = runtime-only.
     */
    build_time: z.boolean().optional(),
    description: z.string().optional(),
    confidence: z.enum(["high", "medium", "low"]),
    evidence: z.array(z.string()),
});

export type SuggestedEnvVar = z.infer<typeof SuggestedEnvVarSchema>;

export const SuggestedEnvGroupSchema = z.object({
    name: z.string(),
    vars: z.array(SuggestedEnvVarSchema),
});

export type SuggestedEnvGroup = z.infer<typeof SuggestedEnvGroupSchema>;

export const SuggestEnvVarsResultSchema = z.object({
    status: z.enum(["ok", "unavailable"]),
    reason: z.string().optional(),
    apps: z.array(SuggestedEnvGroupSchema),
    services: z.array(SuggestedEnvGroupSchema),
});

export type SuggestEnvVarsResult = z.infer<typeof SuggestEnvVarsResultSchema>;
