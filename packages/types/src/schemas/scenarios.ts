import { z } from "zod";

export const DiscoverRequestSchema = z.object({
    action: z.literal("discover"),
});
export type DiscoverRequest = z.infer<typeof DiscoverRequestSchema>;

export const UpRequestSchema = z.object({
    action: z.literal("up"),
    environment: z.string(),
    testRunId: z.string(),
});
export type UpRequest = z.infer<typeof UpRequestSchema>;

export const DownRequestSchema = z.object({
    action: z.literal("down"),
    refs: z.unknown().optional(),
    refsToken: z.string().optional(),
    testRunId: z.string(),
});
export type DownRequest = z.infer<typeof DownRequestSchema>;

export const ScenarioWebhookRequestSchema = z.discriminatedUnion("action", [
    DiscoverRequestSchema,
    UpRequestSchema,
    DownRequestSchema,
]);
export type ScenarioWebhookRequest = z.infer<typeof ScenarioWebhookRequestSchema>;

export const DiscoverScenarioSchema = z.object({
    name: z.string(),
    description: z.string().optional(),
    fingerprint: z.string().optional(),
});

export const DiscoverResponseSchema = z.object({
    environments: z.array(DiscoverScenarioSchema),
});
export type DiscoverResponse = z.infer<typeof DiscoverResponseSchema>;

export const AuthCookieSchema = z.object({
    name: z.string(),
    value: z.string(),
    url: z.string().optional(),
    domain: z.string().optional(),
    path: z.string().optional(),
    expires: z.number().optional(),
    httpOnly: z.boolean().optional(),
    secure: z.boolean().optional(),
    sameSite: z.string().optional(),
});
export type AuthCookie = z.infer<typeof AuthCookieSchema>;

export const AuthHeadersSchema = z.record(z.string(), z.string());
export type AuthHeaders = z.infer<typeof AuthHeadersSchema>;

export const AuthCredentialsSchema = z.record(z.string(), z.string());
export type AuthCredentials = z.infer<typeof AuthCredentialsSchema>;

export const AuthPayloadSchema = z
    .object({
        cookies: z.array(AuthCookieSchema).optional(),
        headers: AuthHeadersSchema.optional(),
        credentials: AuthCredentialsSchema.optional(),
    })
    .passthrough();
export type AuthPayload = z.infer<typeof AuthPayloadSchema>;

export const UpResponseSchema = z.object({
    auth: AuthPayloadSchema.optional(),
    refs: z.unknown().optional(),
    refsToken: z.string().optional(),
    metadata: z.unknown().optional(),
    expiresInSeconds: z.number().optional(),
});
export type UpResponse = z.infer<typeof UpResponseSchema>;

export const DownResponseSchema = z.object({
    ok: z.boolean(),
});
export type DownResponse = z.infer<typeof DownResponseSchema>;

export const ConfigureWebhookInputSchema = z.object({
    applicationId: z.string(),
    webhookUrl: z.url(),
    signingSecret: z.string().min(16),
});

export const RemoveWebhookInputSchema = z.object({
    applicationId: z.string(),
});

export const DiscoverInputSchema = z.object({
    applicationId: z.string(),
});

export const ListScenariosInputSchema = z.object({
    applicationId: z.string(),
});

export const ListInstancesInputSchema = z.object({
    scenarioId: z.string(),
});

export const ListWebhookCallsInputSchema = z.object({
    applicationId: z.string(),
});
