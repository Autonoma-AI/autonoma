import type { PrismaClient } from "@autonoma/db";

/**
 * Reads a scenario's recipe - OUR editable, versioned seed definition (`ScenarioRecipeVersion`, one row per
 * `(scenarioId, snapshotId)`). The scenario-repair diagnoser needs the recipe's `create` graph (what the
 * scenario asks to seed) to reason about whether a failure is a test-expectation problem, a missing-record
 * problem, or a client-factory problem. This is the recipe as stored for a given snapshot, independent of
 * whether the live `scenario up` succeeded - so it is available even when provisioning failed.
 */
export class ScenarioRecipe {
    constructor(private readonly db: PrismaClient) {}

    /**
     * The recipe's `create` graph (the seed request: which entities to create, with their fields/refs), as a
     * JSON string ready for the diagnoser prompt. Returns `undefined` when no recipe version exists for this
     * scenario on this snapshot (e.g. a test with no bound scenario).
     */
    async getCreateGraph(scenarioId: string, snapshotId: string): Promise<string | undefined> {
        const version = await this.db.scenarioRecipeVersion.findUnique({
            where: { scenarioId_snapshotId: { scenarioId, snapshotId } },
            select: { fixtureJson: true },
        });
        if (version == null) return undefined;
        return JSON.stringify(version.fixtureJson.create);
    }
}
