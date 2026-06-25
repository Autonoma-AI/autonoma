import { Badge, Panel, PanelBody, PanelHeader, PanelTitle, stepInstruction } from "@autonoma/blacklight";
import { ScreenshotLightbox } from "components/screenshot-lightbox";
import type { RouterOutputs } from "lib/trpc";

type BugDetail = RouterOutputs["bugs"]["detail"];
type LatestOccurrence = NonNullable<BugDetail["latestOccurrence"]>;

export function ReproductionSteps({ latest }: { latest: LatestOccurrence | undefined }) {
  const steps = latest?.reproductionSteps ?? [];

  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>Reproduction steps</PanelTitle>
      </PanelHeader>
      <PanelBody className="p-0">
        {steps.length === 0 ? (
          <p className="p-5 text-sm text-text-tertiary">No ordered run steps were captured for this occurrence.</p>
        ) : (
          <ol>
            {steps.map((step) => (
              <li key={step.order} className="flex gap-3 border-b border-border-dim p-4 last:border-b-0">
                <Badge
                  variant={step.isFailing ? "status-failed" : "outline"}
                  className="mt-0.5 h-5 shrink-0 font-mono text-3xs"
                >
                  {step.order}
                </Badge>
                <div className="min-w-0">
                  <p
                    className={
                      step.isFailing
                        ? "break-words text-sm font-medium text-status-critical"
                        : "break-words text-sm text-text-primary"
                    }
                  >
                    {stepInstruction(step)}
                  </p>
                  {step.outcome != null && (
                    <p className="mt-1 break-words text-xs leading-relaxed text-text-tertiary">{step.outcome}</p>
                  )}
                  {(step.screenshotBeforeUrl != null || step.screenshotAfterUrl != null) && (
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <StepScreenshot label="Before" src={step.screenshotBeforeUrl} stepOrder={step.order} />
                      <StepScreenshot label="After" src={step.screenshotAfterUrl} stepOrder={step.order} />
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </PanelBody>
    </Panel>
  );
}

function StepScreenshot({ label, src, stepOrder }: { label: string; src: string | undefined; stepOrder: number }) {
  if (src == null) return null;

  return (
    <div className="min-w-0">
      <p className="mb-1 font-mono text-3xs font-semibold uppercase tracking-widest text-text-tertiary">{label}</p>
      <ScreenshotLightbox
        src={src}
        alt={`Step ${stepOrder} ${label.toLowerCase()} screenshot`}
        className="max-h-56 w-full border border-border-dim object-contain"
      />
    </div>
  );
}
