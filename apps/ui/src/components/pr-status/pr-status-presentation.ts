import { type CheckpointTone, PIPELINE_LABEL, type PrPipelineStatus } from "@autonoma/types";

export interface PrStatusPresentation {
    tone: CheckpointTone;
    label: string;
    reason?: string;
}

/**
 * The one place a `PrPipelineStatus` becomes words. Every surface that says anything about a PR's state - the
 * list cell, the PR and main-branch headers, the main-branch chip - reads this, so none of them can drift into
 * describing the same state differently.
 *
 * A completed analysis speaks through its checkpoint summary, whose labels come from `derivePresentation` in
 * `@autonoma/checkpoint`. The in-flight and failed phases get a fixed label here: failures are red
 * (`build_failed` / `deploy_failed` for the preview, `analysis_failed` for the run itself) while the in-flight
 * phases stay neutral and are told apart by their label - Building, then Pending checks, then Analyzing - never
 * by color.
 *
 * The two preview failures are separate words because they send the reader to different places. "Build failed"
 * on an app that built in nine seconds and then crashlooped points at the one set of logs that is fine, and
 * that is exactly what it used to say.
 *
 * `none` has nothing to say, so it returns undefined rather than inventing a word for "no signal yet"; the
 * caller decides whether that renders as a dash or as nothing at all.
 *
 * The switch is exhaustive with no `default`, so an eighth kind on the union is a compile error here rather
 * than a silently unlabelled pill.
 */
export function prStatusPresentation(status: PrPipelineStatus): PrStatusPresentation | undefined {
    switch (status.kind) {
        case "checkpoint":
            return { tone: status.summary.tone, label: status.summary.label, reason: status.summary.reason };
        case "building":
            return { tone: "neutral", label: "Building" };
        case "pending_checks":
            return { tone: "neutral", label: "Pending checks" };
        case "analyzing":
            return { tone: "neutral", label: PIPELINE_LABEL.analyzing };
        case "analysis_failed":
            return { tone: "critical", label: PIPELINE_LABEL.analysisFailed };
        case "build_failed":
            return { tone: "critical", label: "Build failed" };
        // No `reason`: the Health column is as narrow as 108px, where one would be truncated away, and
        // every other non-checkpoint kind is a bare label. What actually went wrong belongs on the
        // preview page, next to the logs that explain it.
        case "deploy_failed":
            return { tone: "critical", label: "Deploy failed" };
        case "none":
            return undefined;
    }
}
