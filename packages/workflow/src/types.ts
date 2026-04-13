export type WorkflowArchitecture = "WEB" | "IOS" | "ANDROID";

export interface TestPlanItem {
    testGenerationId: string;
    scenarioId?: string;
}

export interface WorkflowRef {
    workflowId: string;
    runId: string;
}
