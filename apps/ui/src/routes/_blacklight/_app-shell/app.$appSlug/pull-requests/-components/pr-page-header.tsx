import { Button, Skeleton } from "@autonoma/blacklight";
import type { PrPipelineStatus } from "@autonoma/types";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { CircleNotchIcon } from "@phosphor-icons/react/CircleNotch";
import { GitPullRequestIcon } from "@phosphor-icons/react/GitPullRequest";
import { LightningIcon } from "@phosphor-icons/react/Lightning";
import { RobotIcon } from "@phosphor-icons/react/Robot";
import { useLocation } from "@tanstack/react-router";
import { PrStatusPill } from "components/pr-status/pr-status-pill";
import { useActiveOrg } from "lib/query/auth.queries";
import { useBranchByPr, usePrPipelineStatus } from "lib/query/branches.queries";
import { useApplicationRepositoryFromGitHub, usePullRequestFromGitHub, useRunAnalysis } from "lib/query/github.queries";
import type { RouterOutputs } from "lib/trpc";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";
import { useCurrentApplication } from "routes/_blacklight/_app-shell/-use-current-application";
import { PRMetaRow } from "./pr-meta-row";
import type { PRTab } from "./pr-tabs";

type Repository = RouterOutputs["github"]["getApplicationRepository"];

// The shared PR-page chrome: the top bar (back action + title + status + GitHub link) and the meta
// row (tab switcher + author/branch/details). Rendered once by the PR tab layout so it persists -
// not remounted - as the Outlet swaps between the Overview and Preview tabs.
export function PRPageHeader({ prNumber }: { prNumber: number }) {
  const app = useCurrentApplication();
  const { data: branch } = useBranchByPr(app.id, prNumber);
  const { data: prStatus } = usePrPipelineStatus(app.id, branch.id);
  const pr = usePullRequestFromGitHub(app.id, prNumber);
  const repository = useApplicationRepositoryFromGitHub(app.id);
  const prUrl = pr.data?.url ?? buildPullRequestUrl(repository.data, prNumber);
  const { pathname } = useLocation();
  const activeTab = resolveActiveTab(pathname);

  // Prefer the live GitHub title, fall back to the cached PR title (same source as the PR list), and
  // only fall back to the branch name when neither is available.
  const prTitle = pr.data?.title;
  const title = prTitle ?? branch.prTitle ?? branch.name;
  // Show the cached title immediately rather than a skeleton while the live PR fetch is in flight.
  const showTitleSkeleton = pr.isPending && prTitle == null && branch.prTitle == null;

  return (
    <>
      <PRTopBar
        applicationId={app.id}
        prNumber={prNumber}
        prUrl={prUrl}
        title={title}
        showTitleSkeleton={showTitleSkeleton}
        status={prStatus}
      />
      <PRMetaRow
        applicationId={app.id}
        prNumber={prNumber}
        branchName={branch.name}
        targetBranchName={pr.data?.baseRef ?? app.mainBranch.name}
        pr={pr.data ?? undefined}
        prPending={pr.isPending}
        active={activeTab}
      />
    </>
  );
}

function PRTopBar({
  applicationId,
  prNumber,
  prUrl,
  title,
  showTitleSkeleton,
  status,
}: {
  applicationId: string;
  prNumber: number;
  prUrl: string | undefined;
  title: string;
  showTitleSkeleton: boolean;
  status: PrPipelineStatus;
}) {
  return (
    <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border-dim bg-surface-void px-5">
      <Button variant="ghost" size="sm" render={<AppLink to="/app/$appSlug/pull-requests" />}>
        <ArrowLeftIcon size={14} />
        Back
      </Button>

      {showTitleSkeleton ? (
        <Skeleton className="h-5 w-96" />
      ) : (
        <h1 className="flex min-w-0 flex-1 items-baseline gap-2 text-sm font-medium" title={`#${prNumber} ${title}`}>
          <span className="shrink-0 font-mono text-text-secondary">#{prNumber}</span>
          <span className="truncate text-text-primary">{title}</span>
        </h1>
      )}

      <PrStatusPill status={status} density="comfortable" />

      <RunAnalysisButton applicationId={applicationId} prNumber={prNumber} />

      <Button
        variant="accent"
        size="sm"
        render={<AppLink to="/app/$appSlug/pull-requests/$prNumber/fix" params={{ prNumber }} />}
      >
        <RobotIcon size={14} weight="bold" />
        Fix issues
      </Button>

      {prUrl != null && (
        <a href={prUrl} target="_blank" rel="noopener noreferrer">
          <Button variant="outline" size="sm">
            <GitPullRequestIcon size={14} />
            Open in GitHub
            <ArrowSquareOutIcon size={12} />
          </Button>
        </a>
      )}
    </div>
  );
}

// The "Autonoma UI" analysis trigger from the trigger-config page: start a run for this PR from the dashboard,
// for any branch, without switching to GitHub. Disabled while a request is in flight. Hidden entirely for orgs
// without the merge gate enabled.
function RunAnalysisButton({ applicationId, prNumber }: { applicationId: string; prNumber: number }) {
  const { data: activeOrg } = useActiveOrg();
  const runAnalysis = useRunAnalysis();

  if (activeOrg?.mergeGateEnabled !== true) return null;

  return (
    <Button
      variant="accent"
      size="sm"
      onClick={() => runAnalysis.mutate({ applicationId, prNumber })}
      disabled={runAnalysis.isPending}
      aria-label="pr-run-analysis"
    >
      {runAnalysis.isPending ? (
        <CircleNotchIcon size={14} className="animate-spin" />
      ) : (
        <LightningIcon size={14} weight="fill" />
      )}
      {runAnalysis.isPending ? "Starting..." : "Run analysis"}
    </Button>
  );
}

function resolveActiveTab(pathname: string): PRTab {
  if (pathname.endsWith("/preview")) return "preview";
  if (pathname.endsWith("/usage")) return "usage";
  return "overview";
}

export function buildPullRequestUrl(repository: Repository | undefined, prNumber: number) {
  if (repository == null) return undefined;
  return `https://github.com/${repository.fullName}/pull/${prNumber}`;
}
