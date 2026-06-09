import { type PrismaClient } from "@autonoma/db";
import { type Logger, logger } from "@autonoma/logger";
import { type ScenarioRecipesFile, type ScenarioVariableScalar } from "@autonoma/types";
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
     * Replace all recipe versions for `snapshotId` with the contents of `recipesFile`.
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

        const fixtureJson =
            snapshotId != null
                ? await this.findFixtureForSnapshot(scenarioId, snapshotId)
                : await this.findActiveFixture(scenarioId);

        if (fixtureJson == null) {
            this.logger.warn("No recipe version found", { scenarioId, snapshotId });
            return null;
        }

        return resolveRecipePayload(fixtureJson, testRunId);
    }

    private async findFixtureForSnapshot(scenarioId: string, snapshotId: string): Promise<unknown | null> {
        const recipeVersion = await this.db.scenarioRecipeVersion.findUnique({
            where: { scenarioId_snapshotId: { scenarioId, snapshotId } },
            select: { fixtureJson: true },
        });
        return recipeVersion?.fixtureJson ?? null;
    }

    private async findActiveFixture(scenarioId: string): Promise<unknown | null> {
        const scenario = await this.db.scenario.findUnique({
            where: { id: scenarioId },
            select: { activeRecipeVersion: { select: { fixtureJson: true } } },
        });
        return scenario?.activeRecipeVersion?.fixtureJson ?? null;
    }
}
