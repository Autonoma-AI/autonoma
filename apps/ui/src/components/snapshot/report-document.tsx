import { Badge, Panel, PanelBody, PanelHeader, PanelTitle, Skeleton } from "@autonoma/blacklight";
import type { RouterOutputs } from "lib/trpc";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";
import { ReasoningMarkdown } from "./reasoning-block";

type SnapshotReport = RouterOutputs["branches"]["snapshotReport"];
type SeverityBadgeVariant = "critical" | "high" | "warn" | "secondary";

const SEVERITY_BADGE: Record<string, SeverityBadgeVariant> = {
  critical: "critical",
  high: "high",
  medium: "warn",
  low: "secondary",
};

export function SnapshotReportDocument({ report }: { report: SnapshotReport }) {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <ReasoningPanel
          title="Impact analysis"
          content={report.selection.analysisReasoning}
          empty="Analysis has not produced a summary yet."
        />
        <ReasoningPanel
          title="Resolution"
          content={report.firstIterationReasoning}
          empty="No resolution has been recorded for this snapshot."
        />
      </div>
      <BugsFoundPanel report={report} />
    </div>
  );
}

export function SnapshotReportDocumentSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <Skeleton className="h-80 w-full" />
        <Skeleton className="h-80 w-full" />
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

function ReasoningPanel({ title, content, empty }: { title: string; content: string | undefined; empty: string }) {
  const hasContent = content != null && content.trim().length > 0;

  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>{title}</PanelTitle>
      </PanelHeader>
      <PanelBody>
        {hasContent ? <ReasoningMarkdown content={content} /> : <p className="text-xs text-text-tertiary">{empty}</p>}
      </PanelBody>
    </Panel>
  );
}

function BugsFoundPanel({ report }: { report: SnapshotReport }) {
  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>Bugs found</PanelTitle>
        <span className="font-mono text-2xs text-text-tertiary">
          {report.bugs.length} {report.bugs.length === 1 ? "bug" : "bugs"}
        </span>
      </PanelHeader>
      <PanelBody className={report.bugs.length === 0 ? undefined : "space-y-3"}>
        {report.bugs.length === 0 ? (
          <p className="text-sm text-text-secondary">No bugs were found in this checkpoint.</p>
        ) : (
          report.bugs.map((bug) => (
            <AppLink
              key={bug.bugId}
              to="/app/$appSlug/bugs/$bugId"
              params={{ bugId: bug.bugId }}
              className="flex items-center gap-3 border border-border-dim bg-surface-void p-2 transition-colors hover:border-border-mid hover:bg-surface-raised"
            >
              {bug.screenshotUrl != null ? (
                <img
                  src={bug.screenshotUrl}
                  alt={`Evidence screenshot for bug: ${bug.title}`}
                  className="h-14 w-24 shrink-0 border border-border-mid object-cover"
                  loading="lazy"
                />
              ) : (
                <div className="h-14 w-24 shrink-0 border border-border-mid bg-[repeating-linear-gradient(45deg,var(--surface-base),var(--surface-base)_6px,transparent_6px,transparent_12px)]" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-medium text-text-primary">{bug.title}</span>
                  <Badge variant={SEVERITY_BADGE[bug.severity] ?? "secondary"}>{bug.severity}</Badge>
                </div>
                <p className="mt-1 line-clamp-1 text-xs leading-relaxed text-text-secondary">{bug.description}</p>
                <div className="mt-1 truncate font-mono text-2xs text-text-tertiary">
                  {bug.testSlug ?? "No linked test"} · x{bug.occurrences}{" "}
                  {bug.occurrences === 1 ? "occurrence" : "occurrences"}
                  {bug.stepIndex != null
                    ? ` · step ${bug.stepIndex}${bug.stepTotal != null ? `/${bug.stepTotal}` : ""}`
                    : ""}
                </div>
              </div>
            </AppLink>
          ))
        )}
      </PanelBody>
    </Panel>
  );
}
