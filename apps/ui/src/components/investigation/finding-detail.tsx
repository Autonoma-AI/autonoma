import {
  Badge,
  cn,
  InteractionBadge,
  type OverlayPoint,
  ScreenshotWithOverlay,
  Separator,
  Skeleton,
  VideoPlayer,
} from "@autonoma/blacklight";
import type { InvestigationEvidence, InvestigationFinding, InvestigationRunStep } from "@autonoma/types";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { CodeBlock, githubPermalink } from "components/investigation/code-block";
import type { FindingBadgeVariant } from "components/investigation/finding-category";
import { NavigableLightbox, type NavigableStep } from "components/screenshot-lightbox";
import { type ReactNode, useState } from "react";

export interface FindingBadgeMeta {
  label: string;
  variant: FindingBadgeVariant;
}

/**
 * The full evidence page for a single finding: media, run trace, what-happened / root cause, and code
 * evidence. Presentational and surface-agnostic - the investigation view and the authoritative analysis view
 * both render it, each resolving the finding from its own report store and supplying the matching category
 * `meta` and a `backLink` targeting its own list. `repoFullName` / `commitSha` are optional; without them the
 * code-evidence permalinks simply do not render.
 */
export function FindingDetail({
  finding,
  meta,
  backLink,
  repoFullName,
  commitSha,
}: {
  finding: InvestigationFinding;
  meta: FindingBadgeMeta;
  backLink: ReactNode;
  repoFullName?: string;
  commitSha?: string;
}) {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-text-secondary">
          {backLink}
          <span className="font-mono text-2xs uppercase tracking-widest">Evidence</span>
        </div>
        <h1 className="text-2xl font-medium tracking-tight text-text-primary">{finding.headline}</h1>
        <div className="flex flex-wrap items-center gap-2 font-mono text-2xs text-text-secondary">
          <Badge variant={meta.variant} className="uppercase">
            {meta.label}
          </Badge>
          <span>{finding.slug}</span>
          {finding.confidence != null && <span>· {finding.confidence} confidence</span>}
          {finding.planFidelity != null && <span>· plan: {finding.planFidelity}</span>}
          {finding.stepCount != null && <span>· {finding.stepCount} steps</span>}
        </div>
      </header>

      {finding.error != null ? (
        <Section title="Classification error">
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-surface-void p-4 font-mono text-2xs text-text-secondary">
            {finding.error}
          </pre>
        </Section>
      ) : (
        <FindingBody finding={finding} repoFullName={repoFullName} commitSha={commitSha} />
      )}
    </div>
  );
}

function FindingBody({
  finding,
  repoFullName,
  commitSha,
}: {
  finding: InvestigationFinding;
  repoFullName?: string;
  commitSha?: string;
}) {
  const coveredSlugs = finding.coveredSlugs ?? [];
  return (
    <div className="flex flex-col gap-6">
      <MediaPanel finding={finding} />

      {coveredSlugs.length > 1 && (
        <div className="rounded-lg border border-border-dim bg-surface-raised px-4 py-3">
          <p className="text-sm text-text-primary">
            The same issue was found across <span className="font-medium">{coveredSlugs.length} tests</span> - they were
            reconciled into this one finding.
          </p>
          <ul className="mt-2 flex flex-col gap-1 font-mono text-2xs text-text-secondary">
            {coveredSlugs.map((slug) => (
              <li key={slug}>{slug}</li>
            ))}
          </ul>
        </div>
      )}

      {finding.expectedBehavior != null && (
        <Section title="Expected">
          <p className="text-sm leading-relaxed text-text-primary">{finding.expectedBehavior}</p>
        </Section>
      )}

      {finding.actualBehavior != null && (
        <Section title="Actual">
          <p className="text-sm leading-relaxed text-text-primary">{finding.actualBehavior}</p>
        </Section>
      )}

      {finding.whatHappened != null && (
        <Section title="What happened">
          <p className="text-sm leading-relaxed text-text-primary">{finding.whatHappened}</p>
        </Section>
      )}

      {finding.remediation != null && (
        <Section title="Remediation">
          <p className="text-sm leading-relaxed text-text-primary">{finding.remediation}</p>
        </Section>
      )}

      {finding.observedAppIssues != null && (
        <div className="rounded-lg border border-status-warn/30 bg-status-warn/5 px-4 py-3 text-sm leading-relaxed text-text-primary">
          <span className="font-medium">App issues observed: </span>
          {finding.observedAppIssues}
        </div>
      )}

      {hasRunTrace(finding) && (
        <Section title="Run trace - what the run actually did">
          {finding.runTrace != null && finding.runTrace.length > 0 ? (
            <RunTraceRich steps={finding.runTrace} />
          ) : (
            <RunTrace steps={finding.runSteps ?? []} />
          )}
        </Section>
      )}

      {finding.plan != null && finding.plan.trim() !== "" && (
        <Section title="Reproduction - the test plan">
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-surface-void p-4 font-mono text-2xs text-text-secondary">
            {finding.plan}
          </pre>
        </Section>
      )}

      {finding.evidence.length > 0 && (
        <Section title="Evidence">
          <div className="flex flex-col gap-3">
            {finding.evidence.map((item, i) => (
              <EvidenceItem key={i} item={item} repoFullName={repoFullName} commitSha={commitSha} />
            ))}
          </div>
        </Section>
      )}

      {finding.suggestedFixDiff != null && (
        <Section title="Suggested test fix">
          <DiffBlock diff={finding.suggestedFixDiff} />
        </Section>
      )}

      {(finding.rootCause != null || finding.falsePositiveRisk != null) && <Separator />}

      {finding.rootCause != null && (
        <Section title="Root cause">
          <p className="text-sm leading-relaxed text-text-secondary">{finding.rootCause}</p>
        </Section>
      )}

      {finding.falsePositiveRisk != null && (
        <Section title="False-positive check">
          <p className="text-sm leading-relaxed text-text-secondary">{finding.falsePositiveRisk}</p>
        </Section>
      )}
    </div>
  );
}

function MediaPanel({ finding }: { finding: InvestigationFinding }) {
  if (finding.finalScreenshotUrl == null && finding.videoUrl == null) return null;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {finding.finalScreenshotUrl != null && (
        <figure className="flex flex-col gap-1">
          <img
            src={finding.finalScreenshotUrl}
            alt="Screenshot captured during the run for this finding"
            className="w-full rounded-lg border border-border-dim"
          />
          <figcaption className="font-mono text-3xs uppercase tracking-widest text-text-secondary">
            Run screenshot
          </figcaption>
        </figure>
      )}
      {finding.videoUrl != null && (
        <VideoPlayer src={finding.videoUrl} optimizedSrc={finding.optimizedVideoUrl} label="Run recording" />
      )}
    </div>
  );
}

function EvidenceItem({
  item,
  repoFullName,
  commitSha,
}: {
  item: InvestigationEvidence;
  repoFullName?: string;
  commitSha?: string;
}) {
  const permalink = githubPermalink(repoFullName, commitSha, item.file, item.lines);
  const snippet = item.snippet;
  const fileLabel = item.file != null ? `${item.file}${item.lines != null ? `:${item.lines}` : ""}` : undefined;
  return (
    <div className="flex flex-col gap-2">
      {item.detail !== "" && (
        <p className="text-sm leading-relaxed text-text-secondary">
          <span className="mr-2 font-mono text-3xs uppercase text-text-secondary">[{item.source}]</span>
          {item.detail}
        </p>
      )}
      {snippet != null && snippet !== "" ? (
        <CodeBlock code={snippet} file={item.file} lines={item.lines} sourceLabel={item.source} permalink={permalink} />
      ) : (
        fileLabel != null && (
          <div className="flex items-center gap-2 rounded-md border border-border-dim bg-surface-raised px-3 py-2 font-mono text-3xs">
            <Badge variant="outline" className="uppercase">
              {item.source}
            </Badge>
            {permalink != null ? (
              <a href={permalink} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                {fileLabel}
              </a>
            ) : (
              <span className="text-text-primary">{fileLabel}</span>
            )}
          </div>
        )
      )}
    </div>
  );
}

/**
 * The step-by-step run trace - the run agent's own observation log (interaction + status + per-step error).
 * Steps that errored or failed are highlighted so the verdict can be audited against what actually happened
 * (e.g. a "delete failed" that was really a native dialog the engine could not click).
 */
function RunTrace({ steps }: { steps: string[] }) {
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-surface-void p-4 font-mono text-2xs leading-relaxed">
      {steps.map((step, i) => {
        const failed = /\bERROR\b|\bfailed\b/i.test(step);
        return (
          <div key={i} className={failed ? "text-status-critical" : "text-text-secondary"}>
            {step}
          </div>
        );
      })}
    </pre>
  );
}

/** True when the finding carries either the structured trace (preferred) or the legacy text-only trace. */
function hasRunTrace(finding: InvestigationFinding): boolean {
  return (
    (finding.runTrace != null && finding.runTrace.length > 0) ||
    (finding.runSteps != null && finding.runSteps.length > 0)
  );
}

/** A step's click/drag coordinates as overlay markers (typed, no cast) - in the screenshot's own pixel space. */
function toOverlayPoints(step: InvestigationRunStep): OverlayPoint[] {
  const points: OverlayPoint[] = [];
  if (step.point != null) points.push({ ...step.point, role: "click" });
  if (step.startPoint != null) points.push({ ...step.startPoint, role: "drag-start" });
  if (step.endPoint != null) points.push({ ...step.endPoint, role: "drag-end" });
  return points;
}

/**
 * The inspectable run trace: every step with the frame it captured and the exact point the agent acted on, so a
 * reviewer can verify a verdict against what the app really showed instead of trusting a line that says
 * "success". A step with a frame shows a thumbnail (with the click marker) and opens a full, arrow-navigable
 * lightbox on click; a step without a frame renders as a plain line.
 */
function RunTraceRich({ steps }: { steps: InvestigationRunStep[] }) {
  const [activeIndex, setActiveIndex] = useState<number | undefined>(undefined);
  const [expanded, setExpanded] = useState(false);

  const lightboxSteps: NavigableStep[] = [];
  const lightboxIndexByOrder = new Map<number, number>();
  for (const step of steps) {
    if (step.screenshotUrl == null) continue;
    lightboxIndexByOrder.set(step.order, lightboxSteps.length);
    lightboxSteps.push({
      src: step.screenshotUrl,
      alt: `Step ${step.order} - ${step.interaction}`,
      points: toOverlayPoints(step),
      stepNumber: step.order,
      description: `${step.interaction} - ${step.status}`,
    });
  }
  const frameCount = lightboxSteps.length;

  // Collapsed by default - a 20+ step trace with a thumbnail per row is very tall. "View steps" reveals the
  // inline list; "Open frames" jumps straight into the full-screen player at the first captured frame.
  return (
    <div className="rounded-md bg-surface-void">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 items-center gap-2 font-mono text-2xs text-text-secondary transition-colors hover:text-text-primary"
        >
          <CaretRightIcon size={12} className={cn("shrink-0 transition-transform", expanded && "rotate-90")} />
          <span>{expanded ? "Hide steps" : "View steps"}</span>
          <span className="truncate">
            {steps.length} steps{frameCount > 0 ? ` · ${frameCount} frames` : ""}
          </span>
        </button>
        {frameCount > 0 && (
          <button
            type="button"
            onClick={() => setActiveIndex(0)}
            className="shrink-0 rounded border border-border-dim px-2 py-1 font-mono text-3xs uppercase tracking-widest text-text-secondary transition-colors hover:bg-surface-raised hover:text-text-primary"
          >
            Open frames
          </button>
        )}
      </div>
      {expanded && (
        <div className="flex flex-col gap-1 px-3 pb-3">
          {steps.map((step) => (
            <RunTraceStepRow
              key={step.order}
              step={step}
              onOpen={
                lightboxIndexByOrder.has(step.order)
                  ? () => setActiveIndex(lightboxIndexByOrder.get(step.order))
                  : undefined
              }
            />
          ))}
        </div>
      )}
      <NavigableLightbox
        steps={lightboxSteps}
        activeIndex={activeIndex}
        onClose={() => setActiveIndex(undefined)}
        onNavigate={setActiveIndex}
      />
    </div>
  );
}

/** One run-trace row: order, interaction, status/error, and - when captured - a clickable frame thumbnail. */
function RunTraceStepRow({ step, onOpen }: { step: InvestigationRunStep; onOpen?: () => void }) {
  const failed = step.error != null || /\berror\b|\bfail/i.test(step.status);
  const frame = step.screenshotUrl;

  const body = (
    <>
      <span className="w-5 shrink-0 text-right font-mono text-3xs text-text-secondary">{step.order}</span>
      <InteractionBadge interaction={step.interaction} />
      <span className={cn("font-mono text-3xs", failed ? "text-status-critical" : "text-text-secondary")}>
        {step.status}
      </span>
      {step.error != null && (
        <span className="min-w-0 flex-1 truncate font-mono text-3xs text-status-critical">{step.error}</span>
      )}
      {frame != null && (
        <span className="ml-auto shrink-0 overflow-hidden rounded border border-border-dim">
          <ScreenshotWithOverlay
            src={frame}
            alt={`Step ${step.order} frame`}
            imgClassName="h-10 w-auto"
            overlaySize="sm"
            points={toOverlayPoints(step)}
          />
        </span>
      )}
    </>
  );

  if (onOpen == null) {
    return <div className="flex items-center gap-2 px-1 py-1">{body}</div>;
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex cursor-zoom-in items-center gap-2 rounded px-1 py-1 text-left transition-colors hover:bg-surface-raised"
    >
      {body}
    </button>
  );
}

function DiffBlock({ diff }: { diff: string }) {
  return (
    <pre className="overflow-x-auto rounded-md bg-surface-void p-3 font-mono text-2xs">
      {diff.split("\n").map((line, i) => (
        <div
          key={i}
          className={
            line.startsWith("+")
              ? "text-status-success"
              : line.startsWith("-")
                ? "text-status-critical"
                : "text-text-secondary"
          }
        >
          {line === "" ? " " : line}
        </div>
      ))}
    </pre>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-mono text-2xs uppercase tracking-widest text-text-secondary">{title}</h2>
      {children}
    </section>
  );
}

export function FindingDetailSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="h-64 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}
