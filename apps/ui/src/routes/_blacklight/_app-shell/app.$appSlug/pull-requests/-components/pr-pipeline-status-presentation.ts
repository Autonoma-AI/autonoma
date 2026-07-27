import { type CheckpointTone, PIPELINE_LABEL, type PrPipelineStatus } from "@autonoma/types";

export interface PipelinePillPresentation {
    label: string;
    tone: CheckpointTone;
}

// Label + tone for the non-checkpoint pipeline states, shared by the PR list cell and the PR/main
// headers so they never disagree. The `checkpoint` state renders the snapshot summary and `none`
// renders a placeholder, so neither has an entry here. Failures are red - `build_failed` for the
// preview, `analysis_failed` for the run itself; the in-flight phases stay neutral and are told apart
// by their label (Building -> Pending checks -> Analyzing), never by color.
export function pipelinePillPresentation(kind: PrPipelineStatus["kind"]): PipelinePillPresentation | undefined {
    switch (kind) {
        case "building":
            return { label: "Building", tone: "neutral" };
        case "pending_checks":
            return { label: "Pending checks", tone: "neutral" };
        case "analyzing":
            return { label: PIPELINE_LABEL.analyzing, tone: "neutral" };
        case "analysis_failed":
            return { label: PIPELINE_LABEL.analysisFailed, tone: "critical" };
        case "build_failed":
            return { label: "Build failed", tone: "critical" };
        default:
            return undefined;
    }
}
