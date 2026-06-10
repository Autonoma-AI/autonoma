export const WORKFLOW_TYPE = {
    BATCH_GENERATION: "batchGenerationWorkflow",
    SINGLE_GENERATION: "singleGenerationWorkflow",
    RUN_REPLAY: "runReplayWorkflow",
    GENERATION_REVIEW: "generationReviewWorkflow",
    REPLAY_REVIEW: "replayReviewWorkflow",
    DIFFS_ANALYSIS: "diffsAnalysisWorkflow",
    REFINEMENT_LOOP: "refinementLoopWorkflow",
    RUN_GENERATION_PIPELINE: "runGenerationPipelineWorkflow",
    PREVIEW_DEPLOY: "previewDeployWorkflow",
    PREVIEW_TEARDOWN: "previewTeardownWorkflow",
} as const;

export type WorkflowType = (typeof WORKFLOW_TYPE)[keyof typeof WORKFLOW_TYPE];
