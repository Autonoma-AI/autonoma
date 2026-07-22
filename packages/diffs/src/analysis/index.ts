// The analysis pipeline's classifier library - a COPY of the classifier (classifyRun + vision probes + its
// tools), the deployed comparison, and the holistic dedup, re-homed out of packages/investigation so the merged
// analysis pipeline (impact analysis -> investigators -> reconciler) shares no code with the frozen
// investigation shadow. Exposed via the `@autonoma/diffs/analysis` subpath so it never collides with the diffs
// package's own model-session exports on the main entrypoint.
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
export type { ClassifierDeps, CodebaseReader, PreviewAccess, RunArtifacts } from "./classify/dependencies";
export { withRetry } from "./retry";
export { dedupeAnalysisFindings } from "./dedup";
export type { AnalysisFinding, ReconciledAnalysisFinding, DedupAnalysisFindingsDeps } from "./dedup";
export { summarizeVerdictPlanes } from "./verdict-planes";
export type { AppHealthVerdict, CoverageCategoryCount, CoverageSummary, TwoPlaneSummary } from "./verdict-planes";
export { narrateAnalysis } from "./narrate";
export type { NarrateAnalysisDeps } from "./narrate";
