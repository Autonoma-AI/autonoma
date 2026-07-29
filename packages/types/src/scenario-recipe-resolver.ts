import { createHash } from "node:crypto";
import {
    type ScenarioRecipeVariables,
    ScenarioRecipeSchema,
    type ScenarioVariableDefinition,
    type ScenarioVariableScalar,
    TEST_RUN_SHORT_ID_TOKEN,
    BUILT_IN_RECIPE_TOKEN_LIST,
    isBuiltInRecipeToken,
    isRecord,
} from "./schemas/scenarios";

/**
 * The evaluator for the recipe-token contract declared in `schemas/scenarios.ts`. Every host that sends a `create`
 * graph to a customer's Environment Factory resolves it through here - the platform's provisioner and the planner
 * CLI's validation client alike - so an agent validating its integration locally exercises the payload production
 * would send.
 *
 * Reached through the `@autonoma/types/scenario-recipe-resolver` subpath rather than the package barrel: it needs
 * `node:crypto` for the SHA-256 a short id is derived from, and the barrel is imported by the browser bundle.
 */

const TEMPLATE_PATTERN = /\{\{([a-zA-Z0-9_]+)\}\}/g;
const FULL_TEMPLATE_PATTERN = /^\{\{([a-zA-Z0-9_]+)\}\}$/;
const DERIVED_PLACEHOLDER_PATTERN = /\{([a-zA-Z0-9_]+)\}/g;

/** Characters of the SHA-256 digest a short id keeps - enough to stay unique per run, short enough for a slug. */
const SHORT_ID_LENGTH = 8;

const FIRST_NAMES = ["Alex", "Jordan", "Taylor", "Morgan", "Riley", "Casey", "Avery", "Quinn"];
const LAST_NAMES = ["Smith", "Johnson", "Lee", "Garcia", "Patel", "Nguyen", "Brown", "Wilson"];
const COMPANY_PREFIXES = ["Acme", "Northstar", "Summit", "Atlas", "Pioneer", "Nimbus", "Beacon", "Harbor"];
const COMPANY_SUFFIXES = ["Labs", "Systems", "Works", "Collective", "Cloud", "Dynamics", "Studio", "Partners"];
const LOREM_WORDS = ["alpha", "beta", "gamma", "delta", "signal", "vector", "launch", "pixel", "orbit", "ember"];

const FAKER_GENERATORS: Record<string, (seed: string) => string> = {
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
};

export interface RecipeResolutionResult {
    createPayload: Record<string, unknown>;
    /**
     * Every token that was substituted, mapped to the value it took - the complete record of what makes one
     * provisioning of a recipe differ from the next, so a caller can derive the exact rows to expect.
     */
    resolvedVariables: Record<string, ScenarioVariableScalar>;
}

export interface RecipeCreateGraphResolution {
    /** The `create` graph, tokens unsubstituted. */
    create: Record<string, unknown>;
    /** The recipe's `variables` block, when it declares one. A token it does not name must be a built-in. */
    variables?: ScenarioRecipeVariables;
    /** The run identity tokens resolve against - the `testRunId` the Environment Factory receives. */
    testRunId: string;
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

    return resolveRecipeCreateGraph({ create: parsed.data.create, variables: parsed.data.variables, testRunId });
}

/**
 * Resolve a `create` graph already separated from its recipe envelope - the same substitution
 * `resolveRecipePayload` performs, for a caller holding a graph rather than a whole recipe (a single-entity
 * slice, a graph authored in-flight).
 *
 * Throws if the graph uses a token that neither `variables` nor the built-ins define, or if `variables` defines
 * one the graph never uses.
 */
export function resolveRecipeCreateGraph(params: RecipeCreateGraphResolution): RecipeResolutionResult {
    const { create, testRunId } = params;
    const variables = params.variables ?? {};
    const usedTokens = collectTemplateTokens(create);

    validateRecipeVariables({ usedTokens, variables });

    if (usedTokens.size === 0) {
        return { createPayload: create, resolvedVariables: {} };
    }

    const resolvedVariables = resolveAllTokens({ usedTokens, variables, testRunId });
    const populatedPayload = replaceTemplateTokens(create, resolvedVariables);

    assertNoUnresolvedTokens(populatedPayload);
    return { createPayload: populatedPayload, resolvedVariables };
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

/**
 * Resolve every token the `create` graph uses. An explicit definition always wins
 * over the built-in of the same name, so a recipe that declared its own
 * `testRunId` variable before the built-ins existed keeps behaving identically.
 */
function resolveAllTokens(params: {
    usedTokens: Set<string>;
    variables: ScenarioRecipeVariables;
    testRunId: string;
}): Record<string, ScenarioVariableScalar> {
    const { usedTokens, variables, testRunId } = params;

    const resolved: Record<string, ScenarioVariableScalar> = {};
    for (const tokenName of usedTokens) {
        if (isBuiltInRecipeToken(tokenName) && !(tokenName in variables)) {
            resolved[tokenName] = builtInTokenValue(tokenName, testRunId);
        }
    }

    for (const [tokenName, value] of Object.entries(resolveRecipeVariables(variables, { testRunId }))) {
        resolved[tokenName] = value;
    }
    return resolved;
}

function builtInTokenValue(tokenName: string, testRunId: string): string {
    return tokenName === TEST_RUN_SHORT_ID_TOKEN ? shortHash(testRunId) : testRunId;
}

function validateRecipeVariables(params: { usedTokens: Set<string>; variables: ScenarioRecipeVariables }): void {
    for (const tokenName of params.usedTokens) {
        if (!(tokenName in params.variables) && !isBuiltInRecipeToken(tokenName)) {
            throw new Error(
                `Unknown recipe variable: ${tokenName}. The only tokens a recipe can use are ` +
                    `${BUILT_IN_RECIPE_TOKEN_LIST}; every other value must be concrete.`,
            );
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
    const generate = FAKER_GENERATORS[generator];
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
    return createHash("sha256").update(seed).digest("hex").slice(0, SHORT_ID_LENGTH);
}
