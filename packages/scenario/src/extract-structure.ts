import { type ScenarioRecipe, type ScenarioStructureJson, isRecord, isScenarioRef } from "@autonoma/types";

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

function resolveRefTarget(value: { _ref: string }, aliasTargets: Record<string, string>): string | undefined {
    return aliasTargets[value._ref];
}
