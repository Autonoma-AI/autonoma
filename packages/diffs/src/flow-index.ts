export interface FlowInfo {
    id: string;
    name: string;
    description?: string;
    testSlugs: string[];
}

/**
 * In-memory index of flows (folders) and their tests.
 * Built from DB Folder + TestCase data at context loading time.
 */
export class FlowIndex {
    private readonly flowsByName: Map<string, FlowInfo>;

    constructor(private readonly flows: FlowInfo[]) {
        this.flowsByName = new Map(flows.map((f) => [f.name.toLowerCase(), f]));
    }

    /** All flows with their names, descriptions, and test counts. */
    listFlows() {
        return this.flows.map((f) => ({
            id: f.id,
            name: f.name,
            description: f.description,
            testCount: f.testSlugs.length,
        }));
    }

    /** Test slugs belonging to a flow (case-insensitive name match). */
    getTestSlugs(flowName: string) {
        return this.flowsByName.get(flowName.toLowerCase())?.testSlugs;
    }

    /** Flow info by name (case-insensitive). */
    getFlow(flowName: string) {
        return this.flowsByName.get(flowName.toLowerCase());
    }
}
