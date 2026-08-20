import { Badge, Checkbox, cn } from "@autonoma/blacklight";
import type { AnalysisPrIssue } from "@autonoma/types";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { analysisIssueKindMeta } from "components/analysis/issue-meta";
import { ProseSection, VerdictSectionTitle } from "components/analysis/verdict-story";
import { ScreenshotLightbox } from "components/screenshot-lightbox";
import { useState } from "react";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";

export interface FixIssueRowProps {
  issue: AnalysisPrIssue;
  prNumber: number;
  selected: boolean;
  onToggle: (selected: boolean) => void;
}

export function FixIssueRow({ issue, prNumber, selected, onToggle }: FixIssueRowProps) {
  const [open, setOpen] = useState(false);
  const kind = analysisIssueKindMeta(issue.kind);
  const detailId = `fix-issue-detail-${issue.id}`;

  return (
    <li className="flex flex-col px-4 py-3">
      <div className="flex items-center gap-3">
        <Checkbox
          checked={selected}
          onCheckedChange={onToggle}
          className="shrink-0"
          aria-label={`Include "${issue.title}" in the prompt`}
        />
        {/* The whole row is the disclosure, not just the caret: a 12px hit target is the only way in to the
            expected/actual, the cause and the media. Deselection mutes the title rather than fading the row,
            so the badge and the metadata line stay legible at full contrast. */}
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          aria-expanded={open}
          aria-controls={detailId}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <Badge variant={kind.variant} className="shrink-0 font-mono text-3xs uppercase tracking-wider">
            {kind.label}
          </Badge>
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-sm font-medium",
              selected ? "text-text-primary" : "text-text-secondary",
            )}
          >
            {issue.title}
          </span>
          <span className="hidden shrink-0 font-mono text-3xs text-text-secondary sm:inline">{meta(issue)}</span>
          <CaretRightIcon
            size={12}
            className={cn("shrink-0 text-text-secondary transition-transform", open && "rotate-90")}
          />
        </button>
      </div>

      {open && <IssueDetail id={detailId} issue={issue} prNumber={prNumber} />}
    </li>
  );
}

function meta(issue: AnalysisPrIssue): string {
  const parts: string[] = [issue.severity];
  if (issue.runCount > 1) parts.push(`seen in ${issue.runCount} runs`);
  return parts.join(" · ");
}

function IssueDetail({ id, issue, prNumber }: { id: string; issue: AnalysisPrIssue; prNumber: number }) {
  const media = issue.clipUrl ?? issue.screenshotUrl;

  return (
    <div id={id} className="mt-3 flex flex-col gap-4 border-l border-border-dim pl-4">
      <ProseSection title="Expected">{issue.expectedBehavior}</ProseSection>
      <ProseSection title="Actual">{issue.actualBehavior}</ProseSection>

      {issue.suspectedCause != null && (
        <ProseSection title="Suspected cause" tone="secondary">
          {issue.suspectedCause.explanation}
        </ProseSection>
      )}
      {issue.suspectedCause != null && issue.suspectedCause.codeReferences.length > 0 && (
        <ul className="flex flex-col gap-2">
          {issue.suspectedCause.codeReferences.map((ref) => (
            <li key={`${ref.file}:${ref.lines ?? ""}`} className="flex flex-col gap-1">
              <span className="font-mono text-2xs text-text-secondary">
                {ref.repo != null ? `${ref.repo} › ` : ""}
                {ref.file}
                {ref.lines != null ? `:${ref.lines}` : ""}
              </span>
              {ref.snippet != null && ref.snippet !== "" && (
                <pre className="overflow-x-auto bg-surface-void p-3 font-mono text-2xs text-text-secondary">
                  {ref.snippet}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}

      {issue.coveredTests.length > 0 && (
        <section className="flex flex-col gap-2">
          <VerdictSectionTitle>Covered by</VerdictSectionTitle>
          <ul className="flex flex-col gap-0.5">
            {issue.coveredTests.map((test) => (
              <li key={test.slug} className="font-mono text-2xs text-text-secondary">
                {test.slug}
                {test.origin === "proposed" && " · authored this run"}
              </li>
            ))}
          </ul>
        </section>
      )}

      {media != null && (
        <ScreenshotLightbox
          src={media}
          alt={`The failure behind "${issue.title}"`}
          className="max-w-sm border border-border-dim"
        />
      )}

      <div className="flex flex-wrap items-center gap-4 font-mono text-2xs">
        <AppLink
          to="/app/$appSlug/pull-requests/$prNumber/issues/$issueId"
          params={{ prNumber, issueId: issue.id }}
          className="text-primary-ink hover:underline"
        >
          Issue details
        </AppLink>
        {issue.replayUrl != null && (
          <a
            href={issue.replayUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 text-primary-ink hover:underline"
          >
            Watch the run <ArrowSquareOutIcon size={11} weight="bold" />
          </a>
        )}
      </div>
    </div>
  );
}
