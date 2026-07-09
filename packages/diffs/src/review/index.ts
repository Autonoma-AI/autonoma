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
    buildStepSummary,
    type RenderableReviewStep,
    type ReviewStep,
    type VideoDownloader,
    type EvidenceLoader,
    type ChangeContext,
    type IterationLineage,
    type IterationVerdict,
} from "./kernel";

// Generation reviewer prompt-building blocks. Orchestration (the runner, the
// context loader, the persister) lives in `apps/workers/diffs`.
export { buildGenerationReviewMessages, type GenerationContext, type GenerationStepData } from "./generation";

// The snapshot diff anchor (base/head SHAs) shared by every failing subject.
export type { SnapshotChangeContext } from "./snapshot";

// Healing-scope context: the diff-job context for one refinement iteration's
// failing subjects (full per-test lineage + change facts + per-subject scenario).
// Consumed by the healing agent; the loader that builds it lives in `apps/workers/diffs`.
export type { HealingContext, HealingFailureSubject, HealingSubjectContext } from "./snapshot";
