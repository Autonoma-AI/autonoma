import { cancelAnalysisJob, type TriggerAnalysisJobParams, triggerAnalysisJob } from "./analysis";
import { cancelDiffsJob } from "./diffs";
import { cancelInvestigationJob, type TriggerInvestigationJobParams, triggerInvestigationJob } from "./investigation";

/**
 * Starts and cancels the Temporal workflows a PR review run needs, as one injectable collaborator instead of a bag
 * of loose functions. The API's DiffsTriggerService/DiffsRunPreparer and the diffs-worker `prepareDiffsRun`
 * activity depend on this interface and receive {@link temporalPipelineWorkflows}; tests supply a fake. A missing
 * operation is a compile error, not a runtime surprise.
 *
 * `triggerAnalysis` is the only way to start a PR run. `cancelDiffs` and `cancelInvestigation` remain because
 * supersession still has to close out runs started before the diffs cutover.
 */
export interface PipelineWorkflows {
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
    cancelDiffs: cancelDiffsJob,
    triggerInvestigation: triggerInvestigationJob,
    cancelInvestigation: cancelInvestigationJob,
    triggerAnalysis: triggerAnalysisJob,
    cancelAnalysis: cancelAnalysisJob,
};
