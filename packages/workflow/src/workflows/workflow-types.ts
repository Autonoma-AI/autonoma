export const WORKFLOW_TYPE = {
    BATCH_GENERATION: "batchGenerationWorkflow",
    SINGLE_GENERATION: "singleGenerationWorkflow",
    DIFFS_ANALYSIS: "diffsAnalysisWorkflow",
    REFINEMENT_LOOP: "refinementLoopWorkflow",
    RUN_GENERATION_PIPELINE: "runGenerationPipelineWorkflow",
    INVESTIGATION: "investigationWorkflow",
    INVESTIGATION_MERGE: "investigationMergeWorkflow",
    ANALYSIS: "analysisWorkflow",
    INVESTIGATOR: "investigatorWorkflow",
} as const;

export type WorkflowType = (typeof WORKFLOW_TYPE)[keyof typeof WORKFLOW_TYPE];
