export interface ScenarioSummary {
    id: string;
    name: string;
    description?: string;
}

export interface ScenarioDetail extends ScenarioSummary {
    activeRecipe?: unknown;
    sampleMetadata?: unknown;
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
    flows: FlowSummary[];
    /** Free-text guidelines from the user about what to / not to test for this application. */
    testScopeGuidelines?: string;
}
