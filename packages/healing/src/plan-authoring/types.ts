export interface ScenarioSummary {
    id: string;
    name: string;
    description?: string;
}

export interface ScenarioDetail extends ScenarioSummary {
    activeRecipe?: unknown;
    sampleMetadata?: unknown;
}

/**
 * Structural interface over an index of scenarios. Satisfied by
 * `ScenarioIndex` from `@autonoma/diffs`. Defined here so the healing package
 * (which builds the scenario tools) doesn't have to import from `@autonoma/diffs`
 * and create a dependency cycle.
 */
export interface ScenarioLookup {
    listScenarios(): ScenarioSummary[];
    getScenario(id: string): ScenarioDetail | undefined;
    hasScenario(id: string): boolean;
}

export interface SkillSummary {
    id: string;
    slug: string;
    name: string;
    description: string;
}

export interface FlowSummary {
    id: string;
    name: string;
    description?: string;
    testCount: number;
}

export interface PlanAuthoringContextInput {
    /** When omitted, the rendered section skips the Scenarios block (e.g. for agents that don't pick scenarios). */
    scenarios?: ScenarioSummary[];
    skills: SkillSummary[];
    flows: FlowSummary[];
}
