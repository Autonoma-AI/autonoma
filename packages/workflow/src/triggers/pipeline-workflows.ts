import { cancelAnalysisJob, type TriggerAnalysisJobParams, triggerAnalysisJob } from "./analysis";
import { cancelDiffsJob, type TriggerDiffsJobParams, triggerDiffsJob } from "./diffs";
import { cancelInvestigationJob, type TriggerInvestigationJobParams, triggerInvestigationJob } from "./investigation";

/**
 * Starts and cancels the Temporal workflows that make up a PR review run - the diffs job, the investigation
 * shadow, and the merged analysis pipeline - as one injectable collaborator instead of a bag of loose functions.
 * The API's DiffsTriggerService/DiffsRunPreparer and the diffs-worker `prepareDiffsRun` activity depend on this
 * interface and receive {@link temporalPipelineWorkflows}; tests supply a fake. A missing operation is a compile
 * error, not a runtime surprise.
 */
export interface PipelineWorkflows {
    triggerDiffs(params: TriggerDiffsJobParams): Promise<void>;
    cancelDiffs(snapshotId: string): Promise<void>;
    triggerInvestigation(params: TriggerInvestigationJobParams): Promise<void>;
    cancelInvestigation(snapshotId: string): Promise<void>;
    triggerAnalysis(params: TriggerAnalysisJobParams): Promise<void>;
    cancelAnalysis(snapshotId: string): Promise<void>;
}

/**
 * The production {@link PipelineWorkflows} - a typed adapter binding the Temporal trigger/cancel functions to the
 * interface. No wrapper class: each operation is exactly its module function.
 */
export const temporalPipelineWorkflows: PipelineWorkflows = {
    triggerDiffs: triggerDiffsJob,
    cancelDiffs: cancelDiffsJob,
    triggerInvestigation: triggerInvestigationJob,
    cancelInvestigation: cancelInvestigationJob,
    triggerAnalysis: triggerAnalysisJob,
    cancelAnalysis: cancelAnalysisJob,
};
