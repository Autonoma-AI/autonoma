// Kernel: video upload helper, message-builder utilities, evidence loader, and
// the subject-agnostic change-facts + lineage types/presentation shared by both
// reviewers.
export {
    tryUploadVideo,
    MessageBuilder,
    sanitizeConversation,
    StorageEvidenceLoader,
    buildChangeContextSection,
    buildLineageSection,
    type VideoDownloader,
    type EvidenceLoader,
    type ChangeContext,
    type PlanRevision,
    type PriorVerdict,
    type ReviewLineage,
} from "./kernel";

// Generation reviewer prompt-building blocks. Orchestration (the runner, the
// context loader, the persister) lives in `apps/workers/diffs`.
export { buildGenerationReviewMessages, type GenerationContext, type GenerationStepData } from "./generation";

// Replay reviewer prompt-building blocks. Orchestration lives in `apps/workers/diffs`.
export { buildReplayReviewMessages, type RunContext, type RunStepData } from "./replay";

// Snapshot-scope context: the diff-job context gathered across all replayed
// runs in a snapshot. Consumed by resolution today. The loader that builds it
// lives in `apps/workers/diffs`.
export type { SnapshotChangeContext, SnapshotContext, SnapshotRunContext, SnapshotRunReview } from "./snapshot";

// Healing-scope context: the diff-job context for one refinement iteration's
// failing subjects (full per-test lineage + change facts + per-subject scenario).
// Consumed by the healing agent; the loader that builds it lives in `apps/workers/diffs`.
export type { HealingContext, HealingFailureSubject, HealingSubjectContext } from "./snapshot";
