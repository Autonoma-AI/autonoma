export interface ScenarioRecipe {
    fingerprint: string;
    fixtureJson: unknown;
    validationStatus: string;
}

export interface ScenarioInfo {
    id: string;
    name: string;
    description?: string;
    activeRecipe?: ScenarioRecipe;
    sampleMetadata?: unknown;
}

/**
 * In-memory index of scenarios (test data environments) for an application.
 * Built from DB Scenario + ScenarioRecipeVersion + ScenarioInstance data at context loading time.
 */
export class ScenarioIndex {
    private readonly scenariosById: Map<string, ScenarioInfo>;

    constructor(private readonly scenarios: ScenarioInfo[]) {
        this.scenariosById = new Map(scenarios.map((s) => [s.id, s]));
    }

    /**
     * The underlying scenario array this index was built from.
     *
     * Used to serialize the index back to its raw form (e.g. when freezing an
     * agent input into an on-disk eval fixture) so it can be
     * reconstructed later via `new ScenarioIndex(array)`.
     */
    toArray(): ScenarioInfo[] {
        return this.scenarios;
    }

    /** Lightweight summary of all scenarios for the agent to choose from. */
    listScenarios() {
        return this.scenarios.map((s) => ({
            id: s.id,
            name: s.name,
            description: s.description,
        }));
    }

    /** Rich detail for a single scenario, including its active recipe and a sample of past instance metadata. */
    getScenario(id: string): ScenarioInfo | undefined {
        return this.scenariosById.get(id);
    }

    /** Whether a scenario with this id is known (used to validate agent-supplied ids). */
    hasScenario(id: string): boolean {
        return this.scenariosById.has(id);
    }
}
