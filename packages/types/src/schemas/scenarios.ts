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

// ─── Recipe `create` graph: the canonical structure + reference helpers ──────────────
// The `create` graph is a first-class structure the SDK provisioner and the CLI planner both understand; keep its
// shape + `_alias`/`_ref` semantics defined ONCE here so callers (the SDK resolver, the investigation recipe
// validator) share one source of truth instead of each re-deriving it.

/**
 * A scenario recipe's `create` graph: an object keyed by model name, each value an array of record objects. A
 * record may declare an `_alias` (a local handle) and reference another seeded record with `{ "_ref": "alias" }`
 * anywhere in its fields. This is the exact shape the client's environment-factory receives - a bare array, a
 * scalar, or a non-object record makes the factory reject the whole seed.
 */
export const ScenarioCreateGraphSchema = z.record(z.string(), z.array(z.record(z.string(), z.unknown())));
export type ScenarioCreateGraph = z.infer<typeof ScenarioCreateGraphSchema>;

/** A plain object (not null, not an array) - the only shape a record or a `_ref` wrapper can take. */
export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value != null && !Array.isArray(value);
}

/** The `{ "_ref": "alias" }` reference form - the only referencing form the factory understands. */
export function isScenarioRef(value: unknown): value is { _ref: string } {
    return isRecord(value) && typeof value._ref === "string";
}

/** Every `_alias` declared by a record in the graph. */
export function collectScenarioAliases(graph: ScenarioCreateGraph): Set<string> {
    const aliases = new Set<string>();
    for (const records of Object.values(graph)) {
        for (const record of records) {
            if (typeof record._alias === "string") aliases.add(record._alias);
        }
    }
    return aliases;
}

/** Every `{ "_ref": "alias" }` target reachable anywhere in the graph (refs can nest inside any field). */
export function collectScenarioRefs(graph: ScenarioCreateGraph): string[] {
    const refs: string[] = [];
    const walk = (value: unknown): void => {
        if (isScenarioRef(value)) {
            refs.push(value._ref);
            return;
        }
        if (Array.isArray(value)) {
            for (const item of value) walk(item);
            return;
        }
        if (isRecord(value)) {
            for (const nested of Object.values(value)) walk(nested);
        }
    };
    for (const records of Object.values(graph)) walk(records);
    return refs;
}

/** The distinct `_ref` targets that resolve to no declared `_alias`. Empty means the graph is referentially sound. */
export function findDanglingScenarioRefs(graph: ScenarioCreateGraph): string[] {
    const aliases = collectScenarioAliases(graph);
    return [...new Set(collectScenarioRefs(graph))].filter((ref) => !aliases.has(ref));
}

/**
 * The only tokens Autonoma substitutes into a `create` graph. Everything else in a recipe must be a concrete
 * value - there is no general variable mechanism.
 *
 * `testRunId` is the id sent to the Environment Factory as the `up` request's `testRunId`, so a recipe and the
 * handler receiving it agree on one identity; `testRunShortId` is a hash of it, for columns too short to hold a
 * UUID. They exist because concurrent runs of the same scenario would otherwise collide on unique columns - the
 * one thing a recipe genuinely cannot hardcode.
 */
export const TEST_RUN_ID_TOKEN = "testRunId";
export const TEST_RUN_SHORT_ID_TOKEN = "testRunShortId";
const BUILT_IN_RECIPE_TOKENS: ReadonlySet<string> = new Set([TEST_RUN_ID_TOKEN, TEST_RUN_SHORT_ID_TOKEN]);

/**
 * The built-in tokens written as they appear in a recipe, for error messages and prompts. Rendered once at module
 * load: the set never changes, and this string is built on error paths where recomputing it earns nothing.
 */
export const BUILT_IN_RECIPE_TOKEN_LIST = [...BUILT_IN_RECIPE_TOKENS].map((token) => `{{${token}}}`).join(" and ");

const RECIPE_TEMPLATE_PATTERN = /\{\{([a-zA-Z0-9_]+)\}\}/g;

/** Whether Autonoma substitutes this token name without the recipe declaring anything. */
export function isBuiltInRecipeToken(tokenName: string): boolean {
    return BUILT_IN_RECIPE_TOKENS.has(tokenName);
}

/** Every `{{token}}` anywhere in `value` that Autonoma will not substitute, deduplicated and in first-seen order. */
export function findUnknownRecipeTokens(value: unknown): string[] {
    const unknown = new Set<string>();

    const walk = (node: unknown): void => {
        if (typeof node === "string") {
            for (const match of node.matchAll(RECIPE_TEMPLATE_PATTERN)) {
                const tokenName = match[1];
                if (tokenName != null && !isBuiltInRecipeToken(tokenName)) unknown.add(tokenName);
            }
            return;
        }
        if (Array.isArray(node)) {
            for (const item of node) walk(item);
            return;
        }
        if (isRecord(node)) {
            for (const nested of Object.values(node)) walk(nested);
        }
    };
    walk(value);

    return [...unknown];
}

/**
 * Everything wrong with a candidate `create` graph that is knowable without provisioning: a shape the client's
 * factory cannot read, a `_ref` matching no `_alias`, and tokens that resolve to nothing. One human-readable
 * message per problem, most-structural first; empty means the graph is sound.
 *
 * This is the single definition every gate shares - the planner CLI before it uploads, the API on save, and the
 * investigation repair agent before it spends a dry-run seed - so a recipe cannot pass one check and fail another.
 */
export function findRecipeCreateGraphProblems(create: unknown): string[] {
    const graph = ScenarioCreateGraphSchema.safeParse(create);
    if (!graph.success) {
        // Without a readable graph the remaining checks have nothing to walk, and the factory would reject the
        // whole seed in this shape anyway.
        const issues = graph.error.issues.map((issue) => {
            const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
            return `${path}: ${issue.message}`;
        });
        return [`The create graph must map each model name to an array of records. ${issues.join("; ")}`];
    }

    const problems: string[] = [];

    const danglingRefs = findDanglingScenarioRefs(graph.data);
    if (danglingRefs.length > 0) {
        problems.push(
            `These \`_ref\` targets match no \`_alias\` in the graph: ${danglingRefs.join(", ")}. ` +
                "Declare the alias on the record being referenced, or drop the reference.",
        );
    }

    const unknownTokens = findUnknownRecipeTokens(graph.data);
    if (unknownTokens.length > 0) {
        problems.push(
            `These tokens resolve to nothing: ${unknownTokens.map((token) => `{{${token}}}`).join(", ")}. ` +
                `Autonoma only substitutes ${BUILT_IN_RECIPE_TOKEN_LIST}; replace the rest with concrete values.`,
        );
    }

    return problems;
}

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

export const RefsSchema = z.record(z.string(), z.unknown());
export type Refs = z.infer<typeof RefsSchema>;

export const UpResponseSchema = z.object({
    auth: AuthPayloadSchema.optional(),
    refs: RefsSchema.optional(),
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

export const GetRecipeInputSchema = z.object({
    scenarioId: z.string(),
});

export const UpdateRecipeInputSchema = z.object({
    scenarioId: z.string(),
    fixtureJson: z.string(),
});

// ─── Previewkit Environment Factory (admin manual up/down) ────────

export const PreviewkitEnvFactoryOptionsInputSchema = z.object({
    environmentId: z.string().min(1),
});

export const PreviewkitEnvFactoryUpInputSchema = z.object({
    environmentId: z.string().min(1),
    scenarioId: z.string().min(1),
    sdkUrl: z.url(),
});

export const PreviewkitEnvFactoryDownInputSchema = z.object({
    environmentId: z.string().min(1),
    scenarioId: z.string().min(1),
    sdkUrl: z.url(),
    instanceId: z.string().min(1),
    refs: RefsSchema.optional(),
    refsToken: z.string().optional(),
});

// ─── Preview test user (customer-facing, org-scoped) ──────────────
//
// The tenant-facing counterpart to the admin Environment Factory above. Scoped
// to an application the caller owns; the SDK URL is never accepted from the
// client (the server derives it from the environment) so a caller cannot point
// the signed provisioning request at an arbitrary host.

export const TestUserOptionsInputSchema = z.object({
    applicationId: z.string().min(1),
    environmentId: z.string().min(1),
});

export const TestUserProvisionInputSchema = z.object({
    applicationId: z.string().min(1),
    environmentId: z.string().min(1),
    scenarioId: z.string().min(1),
});

export const TestUserTeardownInputSchema = z.object({
    applicationId: z.string().min(1),
    environmentId: z.string().min(1),
    scenarioId: z.string().min(1),
    instanceId: z.string().min(1),
    refs: RefsSchema.optional(),
    refsToken: z.string().optional(),
});
