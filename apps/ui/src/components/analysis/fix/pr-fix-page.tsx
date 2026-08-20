import { Button, Panel, PanelBody, PanelHeader, PanelTitle, Skeleton } from "@autonoma/blacklight";
import { buildAgentFixPrompt, flattenNarrativeTokens, type AnalysisPrIssue } from "@autonoma/types";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { RobotIcon } from "@phosphor-icons/react/Robot";
import { FixActionBar } from "components/analysis/fix/fix-action-bar";
import { FixFlowsDisclosure } from "components/analysis/fix/fix-flows-disclosure";
import { FixIssueRow } from "components/analysis/fix/fix-issue-row";
import { AnalysisFixEmptyState, AnalysisFixNoIssuesState } from "components/analysis/fix/fix-page-states";
import { AnalysisPrIssuesHeadline } from "components/analysis/pr-issues-headline";
import { useAnalysisForPr } from "lib/query/branches.queries";
import { useApplicationRepositoryFromGitHub } from "lib/query/github.queries";
import type { RouterOutputs } from "lib/trpc";
import { useMemo, useState } from "react";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";
import { useCurrentApplication } from "routes/_blacklight/_app-shell/-use-current-application";

type AnalysisForPr = RouterOutputs["branches"]["analysisForPr"];
type SettledAnalysis = Extract<AnalysisForPr, { status: "complete" }>;

export function PrFixPage({ prNumber }: { prNumber: number }) {
  const app = useCurrentApplication();
  const { data: analysis } = useAnalysisForPr(app.id, prNumber);

  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader prNumber={prNumber} />
      {analysis.status === "complete" ? (
        <SettledFixPage analysis={analysis} prNumber={prNumber} applicationId={app.id} />
      ) : (
        <AnalysisFixEmptyState status={analysis.status} />
      )}
    </div>
  );
}

function SettledFixPage({
  analysis,
  prNumber,
  applicationId,
}: {
  analysis: SettledAnalysis;
  prNumber: number;
  applicationId: string;
}) {
  // Excluded, not selected: every issue starts in the brief and the reader opts out. Seeding a `selected` set
  // from async query data would leave any issue that arrives later silently unticked - the wrong default for a
  // page whose whole job is "here is everything we found".
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  // Best-effort, and deliberately not a suspense read: the prompt degrades to naming the PR by number, so the
  // page must never block on GitHub being readable.
  const { data: repository } = useApplicationRepositoryFromGitHub(applicationId);
  const repoFullName = repository?.fullName;

  const selected = useMemo(
    () => analysis.issues.filter((issue) => !excluded.has(issue.id)),
    [analysis.issues, excluded],
  );
  // Both briefs walk the report prose and every code snippet, so unmemoized they would be rebuilt twice on
  // every checkbox toggle and on every unrelated re-render of this page.
  const prompts = useMemo(() => {
    const input = {
      repoFullName,
      prNumber,
      prUrl: analysis.prUrl,
      run: {
        verdict: analysis.verdict,
        headline: analysis.headline,
        flows: analysis.flows,
        reportMarkdown: flattenReport(analysis),
        impactReasoning: analysis.impactReasoning,
        newerRun: analysis.newerRun,
      },
      issues: selected,
      totalIssueCount: analysis.issues.length,
    };
    return { full: buildAgentFixPrompt(input, "full"), link: buildAgentFixPrompt(input, "link") };
  }, [analysis, prNumber, repoFullName, selected]);

  if (analysis.issues.length === 0) return <AnalysisFixNoIssuesState />;

  const allSelected = excluded.size === 0;

  return (
    <>
      <AnalysisPrIssuesHeadline
        verdict={analysis.verdict}
        title={analysis.title}
        headline={analysis.headline}
        flows={analysis.flows}
      />

      <FixFlowsDisclosure flows={analysis.flows} />

      <Panel>
        <PanelHeader>
          <PanelTitle>Issues to send</PanelTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setExcluded(allSelected ? new Set(analysis.issues.map((issue) => issue.id)) : new Set())}
          >
            {allSelected ? "Select none" : "Select all"}
          </Button>
        </PanelHeader>
        <PanelBody className="p-0">
          <ul className="divide-y divide-border-dim">
            {analysis.issues.map((issue) => (
              <FixIssueRow
                key={issue.id}
                issue={issue}
                prNumber={prNumber}
                selected={!excluded.has(issue.id)}
                onToggle={(include) => setExcluded(toggleExcluded(excluded, issue.id, include))}
              />
            ))}
          </ul>
        </PanelBody>
      </Panel>

      <FixActionBar
        prompt={prompts.full}
        linkPrompt={prompts.link}
        selectedCount={selected.length}
        repoFullName={repoFullName}
      />
    </>
  );
}

function toggleExcluded(excluded: ReadonlySet<string>, issueId: string, include: boolean): ReadonlySet<string> {
  const next = new Set(excluded);
  if (include) next.delete(issueId);
  else next.add(issueId);
  return next;
}

function flattenReport(analysis: SettledAnalysis): string | undefined {
  if (analysis.reportMarkdown == null) return undefined;
  const issueUrlById = new Map(analysis.issues.map((issue: AnalysisPrIssue) => [issue.id, issue.issueUrl]));
  const evidenceById = new Map(analysis.reportEvidence.map((asset) => [asset.assetId, asset.url]));
  return flattenNarrativeTokens(analysis.reportMarkdown, {
    issueUrl: (id) => issueUrlById.get(id),
    evidenceUrl: (id) => evidenceById.get(id),
  });
}

function PageHeader({ prNumber }: { prNumber: number }) {
  return (
    <header className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-text-secondary">
        <AppLink
          to="/app/$appSlug/pull-requests/$prNumber"
          params={{ prNumber }}
          aria-label="Back to pull request"
          className="inline-flex size-5 shrink-0 items-center justify-center text-text-secondary transition-colors hover:bg-surface-raised hover:text-text-primary"
        >
          <ArrowLeftIcon size={12} />
        </AppLink>
        <RobotIcon size={14} />
        <span className="font-mono text-2xs uppercase tracking-widest">Fix it</span>
        <span className="font-mono text-2xs">#{prNumber}</span>
      </div>
      <h1 className="text-2xl font-medium tracking-tight text-text-primary">Hand this PR to a coding agent</h1>
    </header>
  );
}

export function PrFixPageSkeleton() {
  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-8 w-96" />
      </div>
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-3 w-48" />
      <Skeleton className="h-44 w-full" />
    </div>
  );
}
