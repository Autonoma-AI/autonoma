import { Badge, Button, Separator, Skeleton } from "@autonoma/blacklight";
import type { InvestigationEvidence, InvestigationFinding } from "@autonoma/types";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { createFileRoute } from "@tanstack/react-router";
import { CodeBlock, githubPermalink } from "components/investigation/code-block";
import { findingCategoryMeta } from "components/investigation/finding-category";
import { useInvestigationReportData } from "lib/query/branches.queries";
import { useRef, useState } from "react";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";

export const Route = createFileRoute(
  "/_blacklight/_app-shell/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/investigation/$findingId",
)({
  component: FindingDetailPage,
});

function FindingDetailPage() {
  return <FindingDetail />;
}

function FindingDetail() {
  const { prNumber, snapshotId, findingId } = Route.useParams();
  const { data, isPending } = useInvestigationReportData(snapshotId);

  if (isPending) return <DetailSkeleton />;

  const finding = data?.findings.find((f) => f.id === findingId);

  if (finding == null) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink prNumber={prNumber} snapshotId={snapshotId} />
        <p className="rounded-lg border border-border-dim bg-surface-base px-5 py-6 text-sm text-text-secondary">
          This finding could not be found in the report.
        </p>
      </div>
    );
  }

  const meta = findingCategoryMeta(finding.category);
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-text-secondary">
          <BackLink prNumber={prNumber} snapshotId={snapshotId} />
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
        <FindingBody finding={finding} repoFullName={data?.repoFullName} commitSha={data?.commitSha} />
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

      {finding.whatHappened != null && (
        <Section title="What happened">
          <p className="text-sm leading-relaxed text-text-primary">{finding.whatHappened}</p>
        </Section>
      )}

      {finding.runSteps != null && finding.runSteps.length > 0 && (
        <Section title="Run trace - what the run actually did">
          <RunTrace steps={finding.runSteps} />
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

      {finding.plan != null && finding.plan.trim() !== "" && (
        <Section title="Reproduction - the test plan">
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-surface-void p-4 font-mono text-2xs text-text-secondary">
            {finding.plan}
          </pre>
        </Section>
      )}

      {finding.evidence.length > 0 && (
        <Section title="Code evidence">
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

const PLAYBACK_RATES = [1, 2, 4, 8];
const DEFAULT_PLAYBACK_RATE = 8;

function MediaPanel({ finding }: { finding: InvestigationFinding }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  // These recordings are mostly dead time between agent actions, so default to the fastest rate - most reviewers
  // immediately bumped it to 8x anyway. The element resets playbackRate on load, so we reapply on loadedmetadata.
  const [speed, setSpeed] = useState(DEFAULT_PLAYBACK_RATE);
  if (finding.finalScreenshotUrl == null && finding.videoUrl == null) return null;

  const applySpeed = (rate: number) => {
    setSpeed(rate);
    if (videoRef.current != null) videoRef.current.playbackRate = rate;
  };

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
        <figure className="flex flex-col gap-1">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption -- agent run recording, no captions exist */}
          <video
            ref={videoRef}
            src={finding.videoUrl}
            controls
            onLoadedMetadata={() => applySpeed(speed)}
            className="w-full rounded-lg border border-border-dim"
          />
          <div className="flex items-center gap-2">
            <figcaption className="font-mono text-3xs uppercase tracking-widest text-text-secondary">
              Run recording
            </figcaption>
            <div className="ml-auto flex items-center gap-1">
              {PLAYBACK_RATES.map((rate) => (
                <Button
                  key={rate}
                  variant={rate === speed ? "default" : "outline"}
                  size="xs"
                  onClick={() => applySpeed(rate)}
                >
                  {rate}×
                </Button>
              ))}
            </div>
          </div>
        </figure>
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-mono text-2xs uppercase tracking-widest text-text-secondary">{title}</h2>
      {children}
    </section>
  );
}

function BackLink({ prNumber, snapshotId }: { prNumber: number; snapshotId: string }) {
  return (
    <AppLink
      to="/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/investigation"
      params={{ prNumber, snapshotId }}
      aria-label="Back to findings"
      className="inline-flex size-5 shrink-0 items-center justify-center rounded text-text-secondary transition-colors hover:bg-surface-raised hover:text-text-primary"
    >
      <ArrowLeftIcon size={12} />
    </AppLink>
  );
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="h-64 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}
