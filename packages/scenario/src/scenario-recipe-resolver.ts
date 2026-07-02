import { createHash } from "node:crypto";
import {
    type ScenarioRecipe,
    ScenarioRecipeSchema,
    type ScenarioRecipeVariables,
    type ScenarioStructureJson,
    type ScenarioVariableDefinition,
    type ScenarioVariableScalar,
    isRecord,
    isScenarioRef,
} from "@autonoma/types";

const TEMPLATE_PATTERN = /\{\{([a-zA-Z0-9_]+)\}\}/g;
const FULL_TEMPLATE_PATTERN = /^\{\{([a-zA-Z0-9_]+)\}\}$/;
const DERIVED_PLACEHOLDER_PATTERN = /\{([a-zA-Z0-9_]+)\}/g;

const FIRST_NAMES = ["Alex", "Jordan", "Taylor", "Morgan", "Riley", "Casey", "Avery", "Quinn"];
const LAST_NAMES = ["Smith", "Johnson", "Lee", "Garcia", "Patel", "Nguyen", "Brown", "Wilson"];
const COMPANY_PREFIXES = ["Acme", "Northstar", "Summit", "Atlas", "Pioneer", "Nimbus", "Beacon", "Harbor"];
const COMPANY_SUFFIXES = ["Labs", "Systems", "Works", "Collective", "Cloud", "Dynamics", "Studio", "Partners"];
const LOREM_WORDS = ["alpha", "beta", "gamma", "delta", "signal", "vector", "launch", "pixel", "orbit", "ember"];

const FAKER_GENERATORS = {
    "person.firstName": (seed: string) => pickFrom(seed, "first-name", FIRST_NAMES),
    "person.lastName": (seed: string) => pickFrom(seed, "last-name", LAST_NAMES),
    "internet.email": (seed: string) => {
        const first = pickFrom(seed, "email-first", FIRST_NAMES).toLowerCase();
        const last = pickFrom(seed, "email-last", LAST_NAMES).toLowerCase();
        const suffix = shortHash(`${seed}:email-suffix`);
        return `${first}.${last}.${suffix}@example.test`;
    },
    "company.name": (seed: string) => {
        const prefix = pickFrom(seed, "company-prefix", COMPANY_PREFIXES);
        const suffix = pickFrom(seed, "company-suffix", COMPANY_SUFFIXES);
        return `${prefix} ${suffix}`;
    },
    "lorem.words": (seed: string) => [0, 1, 2].map((index) => pickFrom(seed, `lorem-${index}`, LOREM_WORDS)).join(" "),
} satisfies Record<string, (seed: string) => string>;

interface RecipeResolutionResult {
    createPayload: Record<string, unknown>;
    resolvedVariables: Record<string, ScenarioVariableScalar>;
}

/**
 * Validate, parse, and resolve a stored scenario recipe fixture into a concrete
 * `create` payload ready to send to the SDK endpoint.
 *
 * Pure: no DB, no I/O. Deterministic for a given `(fixtureJson, testRunId)` pair.
 */
export function resolveRecipePayload(fixtureJson: unknown, testRunId: string): RecipeResolutionResult {
    const parsed = ScenarioRecipeSchema.safeParse(fixtureJson);
    if (!parsed.success) {
        throw new Error(`Invalid recipe JSON: ${parsed.error.message}`);
    }

    const recipe = parsed.data;
    const variables = recipe.variables ?? {};
    const usedTokens = collectTemplateTokens(recipe.create);

    validateRecipeVariables({ usedTokens, variables });

    if (usedTokens.size === 0) {
        return { createPayload: recipe.create, resolvedVariables: {} };
    }

    const resolvedVariables = resolveRecipeVariables(variables, { testRunId });
    const populatedPayload = replaceTemplateTokens(recipe.create, resolvedVariables);

    assertNoUnresolvedTokens(populatedPayload);
    return { createPayload: populatedPayload, resolvedVariables };
}

/**
 * Compute a deterministic SHA-256 fingerprint over a recipe payload.
 * Used to detect changes across uploads.
 */
export function hashRecipe(recipe: unknown): string {
    return createHash("sha256").update(JSON.stringify(recipe)).digest("hex");
}

/**
 * Derive a structure summary (model -> fields/refs) from the recipes in a file.
 * Used to populate `scenarioSchemaSnapshot.structureJson`.
 *
 * Pure transform; output keys are sorted for stable fingerprints.
 */
export function extractStructure(recipes: ScenarioRecipe[]): ScenarioStructureJson {
    const models: Record<string, { fields: string[]; refs: Record<string, string> }> = {};

    for (const recipe of recipes) {
        const aliasTargets = collectAliasTargets(recipe.create);

        for (const [modelName, entities] of Object.entries(recipe.create)) {
            if (!Array.isArray(entities)) {
                continue;
            }

            const model = models[modelName] ?? { fields: [], refs: {} };
            for (const entity of entities) {
                if (!isRecord(entity)) {
                    continue;
                }

                for (const [key, value] of Object.entries(entity)) {
                    if (key === "_alias") {
                        continue;
                    }

                    if (!model.fields.includes(key)) {
                        model.fields.push(key);
                    }

                    if (isScenarioRef(value)) {
                        const targetModel = resolveRefTarget(value, aliasTargets);
                        if (targetModel != null) {
                            model.refs[key] = targetModel;
                        }
                    }
                }
            }

            models[modelName] = model;
        }
    }

    return {
        models: Object.fromEntries(
            Object.entries(models)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([modelName, model]) => [
                    modelName,
                    {
                        fields: [...model.fields].sort((left, right) => left.localeCompare(right)),
                        refs: Object.fromEntries(
                            Object.entries(model.refs).sort(([left], [right]) => left.localeCompare(right)),
                        ),
                    },
                ]),
        ),
    };
}

interface ScenarioGenerationContext {
    testRunId: string;
}

function collectTemplateTokens(value: unknown, tokens = new Set<string>()): Set<string> {
    if (typeof value === "string") {
        for (const match of value.matchAll(TEMPLATE_PATTERN)) {
            const tokenName = match[1];
            if (tokenName != null) {
                tokens.add(tokenName);
            }
        }
        return tokens;
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            collectTemplateTokens(item, tokens);
        }
        return tokens;
    }

    if (isRecord(value)) {
        for (const item of Object.values(value)) {
            collectTemplateTokens(item, tokens);
        }
    }

    return tokens;
}

function validateRecipeVariables(params: { usedTokens: Set<string>; variables: ScenarioRecipeVariables }): void {
    for (const tokenName of params.usedTokens) {
        if (!(tokenName in params.variables)) {
            throw new Error(`Unknown recipe variable: ${tokenName}`);
        }
    }

    for (const tokenName of Object.keys(params.variables)) {
        if (!params.usedTokens.has(tokenName)) {
            throw new Error(`Unused variable definition: ${tokenName}`);
        }
    }
}

function resolveRecipeVariables(
    variables: ScenarioRecipeVariables,
    context: ScenarioGenerationContext,
): Record<string, ScenarioVariableScalar> {
    return Object.fromEntries(
        Object.entries(variables).map(([tokenName, definition]) => [
            tokenName,
            resolveRecipeVariable({ tokenName, definition, context }),
        ]),
    );
}

function resolveRecipeVariable(params: {
    tokenName: string;
    definition: ScenarioVariableDefinition;
    context: ScenarioGenerationContext;
}): ScenarioVariableScalar {
    const { tokenName, definition, context } = params;

    switch (definition.strategy) {
        case "literal":
            return definition.value;
        case "derived":
            return resolveDerivedValue(tokenName, definition, context);
        case "faker":
            return seededFakerValue(definition.generator, context.testRunId, tokenName);
    }
}

function resolveDerivedValue(
    tokenName: string,
    definition: Extract<ScenarioVariableDefinition, { strategy: "derived" }>,
    context: ScenarioGenerationContext,
): string {
    const placeholders = Array.from(definition.format.matchAll(DERIVED_PLACEHOLDER_PATTERN)).map((match) => match[1]);
    const unsupportedPlaceholder = placeholders.find((placeholder) => placeholder !== "testRunId");
    if (unsupportedPlaceholder != null) {
        throw new Error(
            `Invalid derived format for ${tokenName}: only {testRunId} is supported, found {${unsupportedPlaceholder}}`,
        );
    }

    if (definition.source !== "testRunId") {
        throw new Error(`Invalid derived source for ${tokenName}: ${definition.source}`);
    }

    return definition.format.replaceAll("{testRunId}", context.testRunId);
}

function replaceTemplateTokens(
    value: Record<string, unknown>,
    resolvedVariables: Record<string, ScenarioVariableScalar>,
): Record<string, unknown>;
function replaceTemplateTokens(value: unknown, resolvedVariables: Record<string, ScenarioVariableScalar>): unknown;
function replaceTemplateTokens(value: unknown, resolvedVariables: Record<string, ScenarioVariableScalar>): unknown {
    if (typeof value === "string") {
        const fullMatch = value.match(FULL_TEMPLATE_PATTERN);
        if (fullMatch != null) {
            const tokenName = fullMatch[1];
            if (tokenName != null && tokenName in resolvedVariables) {
                return resolvedVariables[tokenName];
            }
        }

        return value.replace(TEMPLATE_PATTERN, (_match, tokenName: string) => {
            if (!(tokenName in resolvedVariables)) {
                throw new Error(`Unknown recipe variable: ${tokenName}`);
            }
            return String(resolvedVariables[tokenName]);
        });
    }

    if (Array.isArray(value)) {
        return value.map((item) => replaceTemplateTokens(item, resolvedVariables));
    }

    if (!isRecord(value)) {
        return value;
    }

    return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, replaceTemplateTokens(item, resolvedVariables)]),
    );
}

function assertNoUnresolvedTokens(value: unknown): void {
    const unresolvedTokens = collectTemplateTokens(value);
    if (unresolvedTokens.size > 0) {
        throw new Error(`Unresolved recipe variables remain: ${Array.from(unresolvedTokens).sort().join(", ")}`);
    }
}

function seededFakerValue(generator: string, testRunId: string, tokenName: string): string {
    const generate = FAKER_GENERATORS[generator as keyof typeof FAKER_GENERATORS];
    if (generate == null) {
        throw new Error(`Unsupported faker generator: ${generator}`);
    }

    return generate(`${testRunId}:${tokenName}`);
}

function pickFrom(seed: string, label: string, values: string[]): string {
    return values[indexFromSeed(seed, label, values.length)] ?? values[0] ?? "";
}

function indexFromSeed(seed: string, label: string, length: number): number {
    if (length <= 0) {
        return 0;
    }
    const digest = createHash("sha256").update(`${seed}:${label}`).digest("hex");
    const value = Number.parseInt(digest.slice(0, 8), 16);
    return Number.isFinite(value) ? value % length : 0;
}

function shortHash(seed: string): string {
    return createHash("sha256").update(seed).digest("hex").slice(0, 8);
}

function collectAliasTargets(createPayload: ScenarioRecipe["create"]): Record<string, string> {
    const aliasTargets: Record<string, string> = {};

    for (const [modelName, entities] of Object.entries(createPayload)) {
        if (!Array.isArray(entities)) {
            continue;
        }

        for (const entity of entities) {
            if (!isRecord(entity)) {
                continue;
            }

            const alias = entity._alias;
            if (typeof alias === "string" && alias.length > 0) {
                aliasTargets[alias] = modelName;
            }
        }
    }

    return aliasTargets;
}

function resolveRefTarget(value: { _ref: string }, aliasTargets: Record<string, string>): string | null {
    return aliasTargets[value._ref] ?? null;
}
