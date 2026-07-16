import { Button } from "@autonoma/blacklight";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { GitPullRequestIcon } from "@phosphor-icons/react/GitPullRequest";
import { useLocation } from "@tanstack/react-router";
import { useBranchByPr, usePrPipelineStatus } from "lib/query/branches.queries";
import { useApplicationRepositoryFromGitHub, usePullRequestFromGitHub } from "lib/query/github.queries";
import type { RouterOutputs } from "lib/trpc";
import { Suspense } from "react";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";
import { useCurrentApplication } from "routes/_blacklight/_app-shell/-use-current-application";
import { PRDetailHeader } from "./pr-detail-header";
import { type PRTab, PRTabs } from "./pr-tabs";

type Repository = RouterOutputs["github"]["getApplicationRepository"];

// The shared PR-page chrome: breadcrumb + PR detail header + (when a preview exists) the tab bar.
// Rendered once by the PR tab layout so it persists - not remounted - as the Outlet swaps between the
// Overview and Preview tabs. The active tab is derived from the URL, and the checkpoint badge reflects
// the latest snapshot's summary (undefined for a PR with no snapshots yet).
export function PRPageHeader({ prNumber }: { prNumber: number }) {
  const app = useCurrentApplication();
  const { data: branch } = useBranchByPr(app.id, prNumber);
  const { data: prStatus } = usePrPipelineStatus(app.id, branch.id);
  const pr = usePullRequestFromGitHub(app.id, prNumber);
  const repository = useApplicationRepositoryFromGitHub(app.id);
  const prUrl = pr.data?.url ?? buildPullRequestUrl(repository.data, prNumber);
  const { pathname } = useLocation();
  const activeTab: PRTab = pathname.endsWith("/preview") ? "preview" : "overview";

  return (
    <>
      <PRTopBar appName={app.name} architecture={app.architecture} prNumber={prNumber} prUrl={prUrl} />
      <PRDetailHeader
        applicationId={app.id}
        prNumber={prNumber}
        branchName={branch.name}
        cachedTitle={branch.prTitle}
        targetBranchName={pr.data?.baseRef ?? app.mainBranch.name}
        pr={pr.data ?? undefined}
        prPending={pr.isPending}
        status={prStatus}
      />
      <Suspense fallback={null}>
        <PRTabs applicationId={app.id} prNumber={prNumber} active={activeTab} />
      </Suspense>
    </>
  );
}

function PRTopBar({
  appName,
  architecture,
  prNumber,
  prUrl,
}: {
  appName: string;
  architecture: string;
  prNumber: number;
  prUrl: string | undefined;
}) {
  const appInitial = appName.trim().charAt(0).toUpperCase() || "A";

  return (
    <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border-dim bg-surface-void px-5">
      <div className="flex min-w-0 items-center gap-2">
        <span className="inline-flex size-5 shrink-0 items-center justify-center bg-primary font-mono text-3xs font-bold text-primary-foreground">
          {appInitial}
        </span>
        <span className="truncate text-xs font-medium text-text-secondary">
          {appName} / {architecture.toLowerCase()}
        </span>
      </div>

      <div className="flex min-w-0 items-center gap-2 font-mono text-2xs text-text-secondary">
        <span>/</span>
        <AppLink to="/app/$appSlug/pull-requests" className="transition-colors hover:text-text-primary">
          Pull requests
        </AppLink>
        <span>/</span>
        <span className="text-text-primary">#{prNumber}</span>
      </div>

      {prUrl != null && (
        <a href={prUrl} target="_blank" rel="noopener noreferrer" className="ml-auto">
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
