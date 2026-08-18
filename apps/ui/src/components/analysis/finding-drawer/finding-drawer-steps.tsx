import { Badge, ScreenshotWithOverlay, cn, stepInstruction } from "@autonoma/blacklight";
import { CircleNotchIcon } from "@phosphor-icons/react/CircleNotch";
import { XCircleIcon } from "@phosphor-icons/react/XCircle";
import { StepOutputDisplay } from "components/debug/step-output-display";
import { NavigableLightbox, type NavigableStep } from "components/screenshot-lightbox";
import { useState } from "react";
import type { FindingDetailGeneration, FindingDetailStep } from "./finding-drawer-types";

/**
 * The drawer's steps tab: the generation's live-persisted step attempts, each with its instruction (the raw
 * params rendered as prose), status, output, and captured frame with the agent's interaction points overlaid.
 * Frames open a lightbox navigable across the run. A generation that is still running shows a spinner row at
 * the end - the next step is being decided.
 */
export function FindingDrawerSteps({ generation }: { generation: FindingDetailGeneration }) {
  const [lightboxIndex, setLightboxIndex] = useState<number>();
  const lightboxSteps: NavigableStep[] = generation.steps.flatMap((step) => {
    const src = step.screenshotBefore ?? step.screenshotAfter;
    if (src == null) return [];
    return [
      {
        src,
        alt: `Step ${step.order}`,
        points: step.overlayPoints ?? [],
        stepNumber: step.order,
        description: stepInstruction({ interaction: step.interaction, params: step.params }),
      },
    ];
  });
  const lightboxIndexByOrder = new Map(lightboxSteps.map((step, index) => [step.stepNumber, index]));

  return (
    <div className="flex flex-col">
      {generation.steps.length === 0 && (
        <p className="rounded-lg border border-border-dim bg-surface-void px-5 py-6 text-sm text-text-secondary">
          {generation.status === "running" || generation.status === "queued" || generation.status === "pending"
            ? "Waiting for the first step."
            : "No steps were persisted for this run."}
        </p>
      )}
      {generation.steps.map((step) => (
        <StepRow
          key={step.order}
          step={step}
          onOpenFrame={() => setLightboxIndex(lightboxIndexByOrder.get(step.order))}
        />
      ))}
      {generation.status === "running" && generation.steps.length > 0 && (
        <div className="flex items-center gap-2 py-3 text-xs text-status-warn">
          <CircleNotchIcon size={13} className="animate-spin" /> Running - deciding the next step
        </div>
      )}
      <NavigableLightbox
        steps={lightboxSteps}
        activeIndex={lightboxIndex}
        onClose={() => setLightboxIndex(undefined)}
        onNavigate={setLightboxIndex}
      />
    </div>
  );
}

function StepRow({ step, onOpenFrame }: { step: FindingDetailStep; onOpenFrame: () => void }) {
  const frame = step.screenshotBefore ?? step.screenshotAfter;
  return (
    <div className="flex gap-3 border-b border-border-dim py-3 last:border-b-0">
      <div className="flex w-5 shrink-0 flex-col items-center pt-0.5">
        {step.status === "failed" ? (
          <XCircleIcon size={16} className="text-status-critical" />
        ) : (
          <span className="flex size-4 items-center justify-center rounded-full border border-border-mid font-mono text-4xs text-text-secondary">
            {step.order}
          </span>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-start gap-2">
          <span className={cn("text-sm", step.status === "failed" ? "text-status-critical" : "text-text-primary")}>
            {stepInstruction({ interaction: step.interaction, params: step.params })}
          </span>
          <Badge variant="ghost" className="shrink-0 font-mono text-4xs uppercase">
            {step.interaction}
          </Badge>
        </div>
        {step.error != null && (
          <p className="rounded-md border border-status-critical/30 bg-status-critical/5 px-2 py-1 text-xs text-status-critical">
            {step.errorName != null ? `${step.errorName}: ` : ""}
            {step.error}
          </p>
        )}
        {step.output != null && typeof step.output === "object" && !Array.isArray(step.output) && (
          <StepOutputDisplay output={step.output} />
        )}
      </div>
      {frame != null && (
        <button type="button" onClick={onOpenFrame} className="w-28 shrink-0 cursor-zoom-in" aria-label="Open frame">
          <ScreenshotWithOverlay
            src={frame}
            alt={`Step ${step.order}`}
            points={step.overlayPoints}
            overlaySize="sm"
            imgClassName="rounded-md border border-border-dim"
          />
        </button>
      )}
    </div>
  );
}
