import { Button, Skeleton } from "@autonoma/blacklight";
import type { PrPipelineStatus } from "@autonoma/types";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { GitPullRequestIcon } from "@phosphor-icons/react/GitPullRequest";
import { useLocation } from "@tanstack/react-router";
import { useBranchByPr, usePrPipelineStatus } from "lib/query/branches.queries";
import { useApplicationRepositoryFromGitHub, usePullRequestFromGitHub } from "lib/query/github.queries";
import type { RouterOutputs } from "lib/trpc";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";
import { useCurrentApplication } from "routes/_blacklight/_app-shell/-use-current-application";
import { PRMetaRow } from "./pr-meta-row";
import { PrStatusBadge } from "./pr-status-badge";
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
  const activeTab: PRTab = pathname.endsWith("/preview") ? "preview" : "overview";

  // Prefer the live GitHub title, fall back to the cached PR title (same source as the PR list), and
  // only fall back to the branch name when neither is available.
  const prTitle = pr.data?.title;
  const title = prTitle ?? branch.prTitle ?? branch.name;
  // Show the cached title immediately rather than a skeleton while the live PR fetch is in flight.
  const showTitleSkeleton = pr.isPending && prTitle == null && branch.prTitle == null;

  return (
    <>
      <PRTopBar prUrl={prUrl} title={title} showTitleSkeleton={showTitleSkeleton} status={prStatus} />
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
  prUrl,
  title,
  showTitleSkeleton,
  status,
}: {
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
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary" title={title}>
          {title}
        </h1>
      )}

      <PrStatusBadge status={status} />

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

export function buildPullRequestUrl(repository: Repository | undefined, prNumber: number) {
  if (repository == null) return undefined;
  return `https://github.com/${repository.fullName}/pull/${prNumber}`;
}
