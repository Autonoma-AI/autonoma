// The analysis pipeline's classifier library - a COPY of the classifier (classifyRun + vision probes + its
// tools) and the deployed comparison, re-homed out of packages/investigation so the merged analysis pipeline
// (impact analysis -> investigators -> reporter) shares no code with the frozen investigation shadow. Exposed via
// the `@autonoma/diffs/analysis` subpath so it never collides with the diffs package's own model-session exports
// on the main entrypoint.
//
// Selection was intentionally NOT carried over: #1510 replaces Impact Analysis with the DiffsAgent
// (`runDiffsAnalysis`) and the epic rejects the carry-forward the old selector did.

export { Category, Confidence, Evidence, EvidenceSource, PlanFidelity, RunVerdict } from "./schema";
export { PriorRuns } from "./db/prior-runs";
export type { PriorRun, PriorRunsHistory } from "./db/prior-runs";
export { assertSnapshotPending } from "./db/assert-snapshot-pending";
export { PreviewSecrets } from "./preview/preview-secrets";
export { PreviewEnvironment } from "./preview/preview-environment";
export { LocalCodebaseReader } from "./codebase/local-codebase-reader";
export { openModelSession } from "./ai/model-session";
export type { ModelSession, InvestigationModelName, InvestigationModelConfig } from "./ai/model-session";
export { persistInvestigationCosts } from "./ai/persist-costs";
export { queryLokiLogs } from "./logs/loki";
export type { LokiLogQuery } from "./logs/loki";
export { loadPreviewAppLogs } from "./logs/preview-app-logs";
export type { PreviewAppLogsInput } from "./logs/preview-app-logs";
export { CLASSIFIER_SYSTEM_PROMPT, buildVerdictPrompt } from "./classify/prompt";
export { VerdictForModel, toRunVerdict } from "./classify/verdict-schema";
export { classifyRun } from "./classify/classify-run";
export type { ClassifyContext, ClassifyRunResult } from "./classify/classify-run";
export { buildClassifierTools } from "./classify/tools";
export type { ClassifierDeps, CodebaseReader, PreviewAccess, RunArtifacts, RunVideo } from "./classify/dependencies";
export { withRetry } from "./retry";
export { summarizeVerdictPlanes } from "./verdict-planes";
export type {
    AppHealthVerdict,
    CoverageCategoryCount,
    CoverageSummary,
    TwoPlaneSummary,
    VerdictPlaneFinding,
} from "./verdict-planes";

// The Reporter agent: reconciles a job's findings into de-duped, branch-scoped issues and authors one holistic
// PR report, on the AgentLoop harness.
export { ReporterAgent } from "./report";
export type { ReporterAgentConfig } from "./report";
export {
    REPORTER_SYSTEM_PROMPT,
    buildReporterPrompt,
    reporterIssueKindSchema,
    reporterIssueSeveritySchema,
    reporterIssueStatusSchema,
    authoredIssueContentSchema,
} from "./report";
export type {
    ReporterInput,
    ReporterResult,
    ReporterFinding,
    ReporterExistingIssue,
    ReporterPriorReport,
    ReporterScenarioSummary,
    ReporterScenarioRecipe,
    ReporterScenarioLoader,
    ReporterEvidenceAsset,
    ReporterIssueContent,
    ReporterIssueResult,
    ReporterIssueKind,
    ReporterIssueSeverity,
    ReporterIssueStatus,
    ReporterPrMeta,
    AuthoredIssueContent,
    RecordedIssueAction,
} from "./report";
