import { z } from "zod";

/** Service recipes the onboarding UI can add and therefore the suggestion engine may propose. */
export const SuggestableServiceRecipeSchema = z.enum([
    "postgres",
    "redis",
    "valkey",
    "mongodb",
    "upstash",
    "temporal",
    "docker-image",
]);

export type SuggestableServiceRecipe = z.infer<typeof SuggestableServiceRecipeSchema>;

/** Minimal descriptor of an accepted app, so the engine knows which directories to inspect. */
export const SuggestionAppRefSchema = z.object({
    name: z.string(),
    path: z.string(),
    primary: z.boolean().optional(),
});

export type SuggestionAppRef = z.infer<typeof SuggestionAppRefSchema>;

export const SuggestServicesInputSchema = z.object({
    applicationId: z.string(),
    githubRepositoryId: z.number().int().positive().optional(),
    apps: z.array(SuggestionAppRefSchema),
});

export type SuggestServicesInput = z.infer<typeof SuggestServicesInputSchema>;

export const SuggestedServiceSchema = z.object({
    recipe: SuggestableServiceRecipeSchema,
    name: z.string(),
    version: z.string().optional(),
    confidence: z.enum(["high", "medium", "low"]),
    evidence: z.array(z.string()),
});

export type SuggestedService = z.infer<typeof SuggestedServiceSchema>;

export const SuggestServicesResultSchema = z.object({
    status: z.enum(["ok", "unavailable"]),
    reason: z.string().optional(),
    services: z.array(SuggestedServiceSchema),
});

export type SuggestServicesResult = z.infer<typeof SuggestServicesResultSchema>;
