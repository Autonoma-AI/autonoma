import { z } from "zod";

const SdkFieldSchema = z
    .object({
        name: z.string(),
        type: z.string(),
        isRequired: z.boolean().optional(),
        isId: z.boolean().optional(),
        hasDefault: z.boolean().optional(),
    })
    .passthrough();

const SdkModelSchema = z
    .object({
        name: z.string(),
        fields: z.array(SdkFieldSchema),
    })
    .passthrough();

const SdkEdgeSchema = z
    .object({
        from: z.string(),
        to: z.string(),
        localField: z.string(),
        foreignField: z.string(),
        nullable: z.boolean().optional(),
    })
    .passthrough();

const SdkRelationSchema = z
    .object({
        parentModel: z.string(),
        childModel: z.string(),
        parentField: z.string(),
        childField: z.string(),
    })
    .passthrough();

const SdkSchemaSchema = z
    .object({
        models: z.array(SdkModelSchema),
        edges: z.array(SdkEdgeSchema),
        relations: z.array(SdkRelationSchema),
        scopeField: z.string(),
    })
    .passthrough();

export const SdkDiscoverResponseSchema = z
    .object({
        version: z.union([z.string(), z.number()]).optional(),
        sdk: z.record(z.string(), z.unknown()).optional(),
        schema: SdkSchemaSchema,
    })
    .passthrough();
export type SdkDiscoverResponse = z.infer<typeof SdkDiscoverResponseSchema>;

const ScenarioRecipeValidationSchema = z
    .object({
        status: z.literal("validated"),
        method: z.enum(["checkScenario", "checkAllScenarios", "endpoint-up-down"]),
        phase: z.literal("ok"),
        up_ms: z.number().int().nonnegative().optional(),
        down_ms: z.number().int().nonnegative().optional(),
    })
    .passthrough();

const ScenarioVariableScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type ScenarioVariableScalar = z.infer<typeof ScenarioVariableScalarSchema>;

export const ScenarioVariableDefinitionSchema = z.discriminatedUnion("strategy", [
    z.object({
        strategy: z.literal("literal"),
        value: ScenarioVariableScalarSchema,
    }),
    z.object({
        strategy: z.literal("derived"),
        source: z.literal("testRunId"),
        format: z.string(),
    }),
    z.object({
        strategy: z.literal("faker"),
        generator: z.string(),
    }),
]);
export type ScenarioVariableDefinition = z.infer<typeof ScenarioVariableDefinitionSchema>;

export const ScenarioRecipeVariablesSchema = z.record(z.string(), ScenarioVariableDefinitionSchema);
export type ScenarioRecipeVariables = z.infer<typeof ScenarioRecipeVariablesSchema>;

const ScenarioStructureModelSchema = z.object({
    fields: z.array(z.string()),
    refs: z.record(z.string(), z.string()),
});

export const ScenarioStructureJsonSchema = z.object({
    models: z.record(z.string(), ScenarioStructureModelSchema),
});
export type ScenarioStructureJson = z.infer<typeof ScenarioStructureJsonSchema>;

export const ScenarioRecipeSchema = z
    .object({
        name: z.string(),
        description: z.string(),
        create: z.record(z.string(), z.unknown()),
        variables: ScenarioRecipeVariablesSchema.optional(),
        validation: ScenarioRecipeValidationSchema,
    })
    .passthrough();
export type ScenarioRecipe = z.infer<typeof ScenarioRecipeSchema>;

export const ScenarioRecipesFileSchema = z.object({
    version: z.literal(1),
    source: z
        .object({
            discoverPath: z.string(),
            scenariosPath: z.string(),
        })
        .passthrough(),
    validationMode: z.enum(["sdk-check", "endpoint-lifecycle"]),
    recipes: z.array(ScenarioRecipeSchema).min(1),
});
export type ScenarioRecipesFile = z.infer<typeof ScenarioRecipesFileSchema>;

// ─── Webhook Response Schemas ─────────────────────────────────────

export const DiscoverResponseSchema = SdkDiscoverResponseSchema;
export type DiscoverResponse = SdkDiscoverResponse;

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
    ok: z.boolean().optional(),
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
