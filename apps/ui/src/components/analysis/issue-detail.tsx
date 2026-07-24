import { Badge, Separator, Skeleton } from "@autonoma/blacklight";
import type { AnalysisIssueDetail, AnalysisIssueFindingInstance } from "@autonoma/types";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import {
  analysisIssueKindMeta,
  analysisIssueSeverityMeta,
  analysisIssueStatusMeta,
} from "components/analysis/issue-meta";
import { analysisVerdictMeta } from "components/analysis/verdict-meta";
import { ScreenshotLightbox } from "components/screenshot-lightbox";
import { ReasoningMarkdown } from "components/snapshot/reasoning-block";
import { formatRelativeTime } from "lib/format";
import type { ReactNode } from "react";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";

/**
 * The full detail page for one branch-scoped analysis issue: header + lifecycle badges, the designated hero
 * screenshot, expected/actual, the grounded narrative (with inline evidence + `finding:` links resolved), the
 * suspected code-level cause, and the issue's finding instances across the PR's snapshots (each linking to its
 * per-snapshot finding page).
 */
export function AnalysisIssueDetail({ issue, prNumber }: { issue: AnalysisIssueDetail; prNumber: number }) {
  const kindMeta = analysisIssueKindMeta(issue.kind);
  const severityMeta = analysisIssueSeverityMeta(issue.severity);
  const statusMeta = analysisIssueStatusMeta(issue.status);

  // `finding:<slug>` tokens in the narrative resolve to the most recent instance of that test (instances are
  // newest-first), linking to its per-snapshot finding page; an unknown slug renders as plain text.
  const instanceBySlug = new Map<string, AnalysisIssueFindingInstance>();
  for (const instance of issue.findingInstances) {
    if (!instanceBySlug.has(instance.slug)) instanceBySlug.set(instance.slug, instance);
  }
  const renderFindingLink = (slug: string, children: ReactNode): ReactNode => {
    const instance = instanceBySlug.get(slug);
    if (instance == null) return children;
    return (
      <AppLink
        to="/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/findings/$findingId"
        params={{ prNumber, snapshotId: instance.snapshotId, findingId: instance.findingId }}
        className="text-primary hover:underline"
      >
        {children}
      </AppLink>
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-text-secondary">
          <AppLink
            to="/app/$appSlug/pull-requests/$prNumber"
            params={{ prNumber }}
            aria-label="Back to the pull request"
            className="inline-flex size-5 shrink-0 items-center justify-center rounded text-text-secondary transition-colors hover:bg-surface-raised hover:text-text-primary"
          >
            <ArrowLeftIcon size={12} />
          </AppLink>
          <span className="font-mono text-2xs uppercase tracking-widest">Issue</span>
        </div>
        <h1 className="text-2xl font-medium tracking-tight text-text-primary">{issue.title}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={kindMeta.variant} className="uppercase">
            {kindMeta.label}
          </Badge>
          <Badge variant={severityMeta.variant} className="uppercase">
            {severityMeta.label}
          </Badge>
          <Badge variant={statusMeta.variant} className="uppercase">
            {statusMeta.label}
          </Badge>
          {issue.status === "resolved" && issue.resolvedAt != null && (
            <span className="font-mono text-2xs text-text-secondary">
              resolved {formatRelativeTime(issue.resolvedAt)}
            </span>
          )}
        </div>
      </header>

      {issue.primaryScreenshot != null && (
        <ScreenshotLightbox
          src={issue.primaryScreenshot.url}
          alt="The clearest view of this issue"
          className="w-full border border-border-dim"
          points={issue.primaryScreenshot.points.length > 0 ? issue.primaryScreenshot.points : undefined}
        />
      )}

      {issue.expectedBehavior != null && (
        <Section title="Expected">
          <p className="text-sm leading-relaxed text-text-primary">{issue.expectedBehavior}</p>
        </Section>
      )}

      <Section title="Actual">
        <p className="text-sm leading-relaxed text-text-primary">{issue.actualBehavior}</p>
      </Section>

      {issue.narrativeMarkdown.trim() !== "" && (
        <Section title="Why this is an issue">
          <ReasoningMarkdown
            content={issue.narrativeMarkdown}
            evidence={issue.evidence}
            renderFindingLink={renderFindingLink}
          />
        </Section>
      )}

      {issue.suspectedCause != null && (
        <>
          <Separator />
          <Section title="Suspected cause">
            <p className="text-sm leading-relaxed text-text-secondary">{issue.suspectedCause.explanation}</p>
            {issue.suspectedCause.codeReferences.length > 0 && (
              <ul className="mt-2 flex flex-col gap-2">
                {issue.suspectedCause.codeReferences.map((ref, i) => (
                  <li key={i} className="flex flex-col gap-1">
                    <span className="font-mono text-2xs text-text-secondary">
                      {ref.file}
                      {ref.lines != null ? `:${ref.lines}` : ""}
                    </span>
                    {ref.snippet != null && ref.snippet !== "" && (
                      <pre className="overflow-x-auto rounded-md bg-surface-void p-3 font-mono text-2xs text-text-secondary">
                        {ref.snippet}
                      </pre>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </>
      )}

      <Section title={`Finding instances · ${issue.findingInstances.length}`}>
        {issue.findingInstances.length === 0 ? (
          <p className="text-sm text-text-secondary">No finding instances are attributed to this issue yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {issue.findingInstances.map((instance) => (
              <FindingInstanceRow
                key={`${instance.snapshotId}-${instance.findingId}`}
                instance={instance}
                prNumber={prNumber}
              />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function FindingInstanceRow({ instance, prNumber }: { instance: AnalysisIssueFindingInstance; prNumber: number }) {
  const meta = analysisVerdictMeta(instance.category);
  return (
    <li>
      <AppLink
        to="/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/findings/$findingId"
        params={{ prNumber, snapshotId: instance.snapshotId, findingId: instance.findingId }}
        className="flex items-center gap-4 rounded-lg border border-border-dim bg-surface-void px-4 py-3 transition-colors hover:border-border-mid hover:bg-surface-raised"
      >
        <Badge variant={meta.variant} className="shrink-0 font-mono uppercase">
          {meta.label}
        </Badge>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-text-primary">{instance.headline}</p>
          <p className="truncate font-mono text-2xs text-text-secondary">
            {instance.slug}
            {instance.headSha != null ? ` · ${instance.headSha.slice(0, 7)}` : ""} ·{" "}
            {formatRelativeTime(instance.snapshotCreatedAt)}
          </p>
        </div>
        <CaretRightIcon size={14} className="shrink-0 text-text-secondary" />
      </AppLink>
    </li>
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

export function AnalysisIssueDetailSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="h-64 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}
