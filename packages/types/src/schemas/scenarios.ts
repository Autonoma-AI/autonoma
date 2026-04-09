import { z } from "zod";

// ─── Webhook Response Schemas ─────────────────────────────────────

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

// ─── tRPC Input Schemas ───────────────────────────────────────────

export const ConfigureWebhookInputSchema = z.object({
    applicationId: z.string(),
    deploymentId: z.string(),
    webhookUrl: z.url(),
    webhookHeaders: z.record(z.string(), z.string()).optional(),
});

export const RemoveWebhookInputSchema = z.object({
    applicationId: z.string(),
    deploymentId: z.string(),
});

export const DiscoverInputSchema = z.object({
    applicationId: z.string(),
    deploymentId: z.string(),
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

export const DryRunInputSchema = z.object({
    applicationId: z.string(),
    scenarioId: z.string(),
});
