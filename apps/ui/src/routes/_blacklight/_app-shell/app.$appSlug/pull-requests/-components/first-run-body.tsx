import { AgentCube, type AgentCubeState, ReviewPipeline, type ReviewPipelineStage } from "@autonoma/blacklight";
import type { PrPipelineStatus } from "@autonoma/types";

const STAGE_BY_KIND = {
  building: "preview",
  pending_checks: "preview",
  analyzing: "run",
} as const satisfies Partial<Record<PrPipelineStatus["kind"], ReviewPipelineStage>>;

export type InFlightPipelineKind = keyof typeof STAGE_BY_KIND;

/** Asked of the rail map itself, so placing a kind on the rail is the only edit adding an in-flight kind takes. */
export function isInFlightPipelineKind(kind: PrPipelineStatus["kind"]): kind is InFlightPipelineKind {
  return Object.hasOwn(STAGE_BY_KIND, kind);
}

const CUBE_BY_KIND: Record<InFlightPipelineKind, AgentCubeState> = {
  building: "processing",
  pending_checks: "processing",
  analyzing: "analyzing",
};

const HEADLINE_BY_KIND: Record<InFlightPipelineKind, string> = {
  building: "Building the preview environment.",
  pending_checks: "The preview is up. Waiting on checks.",
  analyzing: "Running your test suite against the preview.",
};

/**
 * No estimate: the analyze phase has no measured percentiles, and `preview-waiting.tsx` sets the rule that a
 * promise the page visibly breaks is worse than no promise. It gets a phase name and nothing more.
 */
export function FirstRunBody({ kind, prNumber }: { kind: InFlightPipelineKind; prNumber: number }) {
  return (
    <div className="flex items-start gap-4 border-b border-border-dim bg-surface-raised/30 px-4 py-4">
      <AgentCube state={CUBE_BY_KIND[kind]} size={34} className="mt-0.5 shrink-0" />

      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-col gap-1">
          <span className="font-mono text-4xs font-semibold uppercase tracking-widest text-primary-ink">
            Your first review · #{prNumber}
          </span>
          <h3 className="text-base font-semibold text-text-primary">{HEADLINE_BY_KIND[kind]}</h3>
          <p className="text-sm leading-relaxed text-text-secondary">
            The verdict arrives as a comment on the pull request. You do not need to keep this open.
          </p>
        </div>

        <ReviewPipeline activeStage={STAGE_BY_KIND[kind]} />
      </div>
    </div>
  );
}
