export const WORKFLOW_TYPE = {
    BATCH_GENERATION: "batchGenerationWorkflow",
    SINGLE_GENERATION: "singleGenerationWorkflow",
    ANALYSIS_RUN: "analysisRunWorkflow",
    PREVIEW_BUILD: "previewBuildWorkflow",
    INVESTIGATOR: "investigatorWorkflow",
} as const;

export type WorkflowType = (typeof WORKFLOW_TYPE)[keyof typeof WORKFLOW_TYPE];
