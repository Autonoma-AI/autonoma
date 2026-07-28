import { type PrismaClient } from "@autonoma/db";
import { BadRequestError } from "@autonoma/errors";
import { type Logger, logger } from "@autonoma/logger";
import {
    type ScenarioRecipe,
    ScenarioRecipeSchema,
    type ScenarioRecipesFile,
    type ScenarioVariableScalar,
} from "@autonoma/types";
import { findRecipeProblems } from "./find-recipe-problems";
import { extractStructure, hashRecipe, resolveRecipePayload } from "./scenario-recipe-resolver";

interface ReplaceParams {
    snapshotId: string;
    applicationId: string;
    recipesFile: ScenarioRecipesFile;
}

interface ReplaceResult {
    scenarioCount: number;
    scenarios: Array<{ id: string; name: string; recipeVersionId: string }>;
}

interface LoadParams {
    scenarioId: string;
    snapshotId?: string;
    testRunId: string;
}

interface LoadResult {
    createPayload: unknown;
    resolvedVariables: Record<string, ScenarioVariableScalar>;
    /** Identity of the version this payload came from, for stamping provenance on the run. */
    recipeVersionId: string;
    recipeFingerprint: string;
}

/** A stored recipe version: its identity plus the unresolved recipe it holds. */
interface StoredVersion {
    id: string;
    fingerprint: string;
    fixtureJson: unknown;
}

interface RawFixtureParams {
    scenarioId: string;
    /** When supplied, the recipe version pinned to this snapshot is returned.
     *  When omitted, the scenario's currently-active recipe version is used. */
    snapshotId?: string;
}

/**
 * Persistence layer for scenario recipes.
 *
 * Owns ingestion (`replaceScenarioRecipes`) and lookup (`loadRecipePayload`).
 * Pure templating/structure logic lives in `scenario-recipe-resolver.ts`.
 */
export class ScenarioRecipeStore {
    private readonly logger: Logger;

    constructor(private readonly db: PrismaClient) {
        this.logger = logger.child({ name: this.constructor.name });
    }

    /**
     * Replace all recipe versions for `snapshotId` with the contents of `recipesFile`. This is the
     * planner's one-time seed for a newly onboarded app, so replacing wholesale is the intent.
     * Upserts the schema snapshot, creates new recipe versions, retargets the
     * scenarios' active recipe pointer, and disables scenarios that no longer
     * appear in the file. Throws when the application does not exist.
     */
    async replaceScenarioRecipes(params: ReplaceParams): Promise<ReplaceResult> {
        const { snapshotId, applicationId, recipesFile } = params;
        this.logger.info("Replacing scenario recipes", {
            applicationId,
            snapshotId,
            recipeCount: recipesFile.recipes.length,
        });

        const application = await this.db.application.findUnique({
            where: { id: applicationId },
            select: { organizationId: true },
        });
        if (application == null) {
            throw new Error(`Application ${applicationId} not found`);
        }
        const { organizationId } = application;

        assertRecipesCanProvision(recipesFile.recipes);

        const recipeNames = recipesFile.recipes.map((recipe) => recipe.name);
        const now = new Date();
        const structureJson = extractStructure(recipesFile.recipes);
        const structureFingerprint = hashRecipe(structureJson);

        return this.db.$transaction(async (tx) => {
            const ingestedScenarios: Array<{ id: string; name: string; recipeVersionId: string }> = [];
            const schemaSnapshot = await tx.scenarioSchemaSnapshot.upsert({
                where: { applicationId_snapshotId: { applicationId, snapshotId } },
                create: {
                    applicationId,
                    snapshotId,
                    structureJson: structureJson as any,
                    fingerprint: structureFingerprint,
                },
                update: {
                    structureJson: structureJson as any,
                    fingerprint: structureFingerprint,
                },
                select: { id: true },
            });

            // Delete existing recipe versions for this snapshot so the latest upload is authoritative
            await tx.scenarioRecipeVersion.deleteMany({
                where: { applicationId, snapshotId },
            });

            for (const recipe of recipesFile.recipes) {
                const fingerprint = hashRecipe(recipe);

                const existing = await tx.scenario.findUnique({
                    where: { applicationId_name: { applicationId, name: recipe.name } },
                    select: {
                        id: true,
                        lastSeenFingerprint: true,
                    },
                });

                const fingerprintChanged =
                    existing?.lastSeenFingerprint != null && existing.lastSeenFingerprint !== fingerprint;
                let scenarioId = existing?.id;

                if (scenarioId == null) {
                    const createdScenario = await tx.scenario.create({
                        data: {
                            applicationId,
                            organizationId,
                            name: recipe.name,
                            description: recipe.description,
                            lastSeenFingerprint: fingerprint,
                            lastDiscoveredAt: now,
                            fingerprintChangedAt: now,
                            isDisabled: false,
                        },
                        select: { id: true },
                    });
                    scenarioId = createdScenario.id;
                }

                const createdVersion = await tx.scenarioRecipeVersion.create({
                    data: {
                        scenarioId,
                        snapshotId,
                        schemaSnapshotId: schemaSnapshot.id,
                        applicationId,
                        organizationId,
                        scenarioNameSnapshot: recipe.name,
                        description: recipe.description,
                        fingerprint,
                        validationStatus: recipe.validation.status,
                        validationMethod: recipe.validation.method,
                        validationPhase: recipe.validation.phase,
                        validationUpMs: recipe.validation.up_ms,
                        validationDownMs: recipe.validation.down_ms,
                        fixtureJson: recipe as any,
                    },
                    select: { id: true },
                });

                await tx.scenario.update({
                    where: { id: scenarioId },
                    data: {
                        description: recipe.description,
                        activeRecipeVersionId: createdVersion.id,
                        lastSeenFingerprint: fingerprint,
                        lastDiscoveredAt: now,
                        isDisabled: false,
                        ...(fingerprintChanged ? { fingerprintChangedAt: now } : {}),
                    },
                });

                await tx.scenarioRecipeEdit.create({
                    data: {
                        scenarioId,
                        applicationId,
                        organizationId,
                        recipeVersionId: createdVersion.id,
                        snapshotId,
                        fingerprint,
                        fixtureJson: recipe,
                        source: "PLANNER",
                    },
                });

                ingestedScenarios.push({ id: scenarioId, name: recipe.name, recipeVersionId: createdVersion.id });
            }

            await tx.scenario.updateMany({
                where: {
                    applicationId,
                    isDisabled: false,
                    ...(recipeNames.length > 0 ? { name: { notIn: recipeNames } } : {}),
                },
                data: { isDisabled: true },
            });

            this.logger.info("Scenario recipes replaced", {
                applicationId,
                snapshotId,
                scenarioCount: ingestedScenarios.length,
            });
            return { scenarioCount: recipesFile.recipes.length, scenarios: ingestedScenarios };
        });
    }

    /**
     * Load and resolve a scenario's recipe payload.
     *
     * When `snapshotId` is supplied, the recipe version pinned to that snapshot
     * is used. When omitted, the scenario's currently-active recipe version is
     * used. Returns `null` when no recipe version is found for the lookup.
     */
    async loadRecipePayload(params: LoadParams): Promise<LoadResult | null> {
        const { scenarioId, snapshotId, testRunId } = params;
        this.logger.info("Loading recipe", { scenarioId, snapshotId, testRunId });

        const version =
            snapshotId != null
                ? await this.findVersionForSnapshot(scenarioId, snapshotId)
                : await this.findActiveVersion(scenarioId);

        if (version == null) {
            this.logger.warn("No recipe version found", { scenarioId, snapshotId });
            return null;
        }

        return {
            ...resolveRecipePayload(version.fixtureJson, testRunId),
            recipeVersionId: version.id,
            recipeFingerprint: version.fingerprint,
        };
    }

    /**
     * Return the raw, unresolved `fixtureJson` stored for a scenario.
     *
     * When `snapshotId` is supplied the recipe version pinned to that snapshot
     * is returned. When omitted the scenario's currently-active recipe version
     * is used. Returns `null` when no matching recipe version exists.
     *
     * The returned value is the full `ScenarioRecipe` object as stored - no
     * variable substitution has been applied. Pass it to `resolveRecipePayload`
     * together with a fresh `testRunId` to obtain a concrete create-payload.
     */
    async loadRawFixture(params: RawFixtureParams): Promise<ScenarioRecipe | null> {
        const { scenarioId, snapshotId } = params;
        this.logger.info("Loading raw fixture", { scenarioId, snapshotId });

        const raw = (
            snapshotId != null
                ? await this.findVersionForSnapshot(scenarioId, snapshotId)
                : await this.findActiveVersion(scenarioId)
        )?.fixtureJson;

        if (raw == null) {
            this.logger.warn("No recipe version found for raw fixture", { scenarioId, snapshotId });
            return null;
        }

        return ScenarioRecipeSchema.parse(raw);
    }

    private async findVersionForSnapshot(scenarioId: string, snapshotId: string): Promise<StoredVersion | null> {
        return this.db.scenarioRecipeVersion.findUnique({
            where: { scenarioId_snapshotId: { scenarioId, snapshotId } },
            select: { id: true, fingerprint: true, fixtureJson: true },
        });
    }

    private async findActiveVersion(scenarioId: string): Promise<StoredVersion | null> {
        const scenario = await this.db.scenario.findUnique({
            where: { id: scenarioId },
            select: { activeRecipeVersion: { select: { id: true, fingerprint: true, fixtureJson: true } } },
        });
        return scenario?.activeRecipeVersion ?? null;
    }
}

/**
 * Reject an upload carrying a recipe that cannot provision. Storing one only defers
 * the failure to test time, where it costs a deploy and a full run to discover -
 * and the uploader is an agent that can fix and re-post immediately, so the message
 * names the offending recipe and every problem in it.
 */
function assertRecipesCanProvision(recipes: ScenarioRecipe[]): void {
    const rejections = recipes.flatMap((recipe) => {
        const problems = findRecipeProblems(recipe);
        if (problems.length === 0) return [];
        return [`"${recipe.name}":\n${problems.map((problem) => `  - ${problem}`).join("\n")}`];
    });

    if (rejections.length > 0) {
        throw new BadRequestError(`Scenario recipes will not provision:\n${rejections.join("\n")}`);
    }
}
