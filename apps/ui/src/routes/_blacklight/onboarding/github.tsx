import {
  Button,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from "@autonoma/blacklight";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { GithubLogoIcon } from "@phosphor-icons/react/GithubLogo";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { Navigate, createFileRoute, useNavigate } from "@tanstack/react-router";
import { buildOnboardingSearch } from "lib/onboarding/onboarding-search";
import {
  useApplicationRepositoryFromGitHub,
  useGithubConfig,
  useGithubInstallation,
  useGithubRepositories,
  useLinkRepository,
} from "lib/query/github.queries";
import { useCompleteGithub } from "lib/query/onboarding.queries";
import { Component, Suspense, useState, type ReactNode } from "react";
import { z } from "zod";
import { OnboardingPageHeader } from "./-components/onboarding-page-header";

const githubSearchParams = z.object({
  appId: z.string().optional(),
  error: z.string().optional(),
});

export const Route = createFileRoute("/_blacklight/onboarding/github")({
  component: RouteComponent,
  validateSearch: githubSearchParams,
});

function RouteComponent() {
  const { appId } = Route.useSearch();
  return <Navigate to="/onboarding" search={buildOnboardingSearch("github", appId)} />;
}

function getErrorMessage(error: string): string {
  switch (error) {
    case "install_failed":
      return "GitHub App installation failed. Please try again.";
    case "install_cancelled":
      return "GitHub App installation was cancelled.";
    default:
      return `GitHub error: ${error}`;
  }
}

export function GitHubPage({ appId }: { appId?: string }) {
  const applicationId = appId;
  // Check if we arrived here from a GitHub OAuth callback with an error
  const urlParams = new URLSearchParams(window.location.search);
  const error = urlParams.get("error") ?? undefined;

  if (applicationId == null) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="font-mono text-sm text-text-secondary">No application found. Please start from the beginning.</p>
      </div>
    );
  }

  return (
    <>
      <OnboardingPageHeader
        leading={
          <div className="mb-4 flex size-12 items-center justify-center rounded-full border border-primary-ink/20 bg-surface-base">
            <GithubLogoIcon size={22} weight="duotone" className="text-primary-ink" />
          </div>
        }
        title="Connect repository"
        description={
          <p className="max-w-2xl">
            Choose the repository Autonoma will deploy with PreviewKit or observe through your existing deploys.
          </p>
        }
        descriptionClassName="text-sm"
      />

      {error != null && (
        <div className="mb-8 flex items-start gap-3 border border-status-critical/30 bg-status-critical/5 px-5 py-4">
          <WarningCircleIcon size={20} weight="fill" className="mt-0.5 shrink-0 text-status-critical" />
          <p className="font-mono text-sm text-status-critical">{getErrorMessage(error)}</p>
        </div>
      )}

      <GitHubErrorBoundary>
        <Suspense fallback={<GitHubContentSkeleton />}>
          <GitHubContent appId={applicationId} />
        </Suspense>
      </GitHubErrorBoundary>
    </>
  );
}

function GitHubContentSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-12 w-full max-w-lg" />
      <Skeleton className="h-10 w-48" />
    </div>
  );
}

class GitHubErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  override state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override render() {
    if (this.state.error != null) {
      return (
        <div className="flex items-start gap-3 rounded border border-status-critical/30 bg-status-critical/5 px-5 py-4">
          <WarningCircleIcon size={20} weight="fill" className="mt-0.5 shrink-0 text-status-critical" />
          <div>
            <p className="text-sm font-medium text-text-primary">Failed to load GitHub configuration</p>
            <p className="mt-1 font-mono text-3xs text-text-secondary">{this.state.error.message}</p>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function GitHubContent({ appId }: { appId: string }) {
  const { data: installation } = useGithubInstallation();

  if (installation == null) {
    return <ConnectStep appId={appId} />;
  }

  return <RepoSelectionStep appId={appId} />;
}

function ConnectStep({ appId }: { appId: string }) {
  const returnPath = `/onboarding/github?appId=${encodeURIComponent(appId)}`;
  const { data } = useGithubConfig(returnPath);

  return (
    <div className="space-y-6">
      <p className="font-mono text-sm text-text-secondary">
        Install the Autonoma GitHub App on the repository Autonoma should deploy or observe for preview environments.
      </p>

      <Button
        variant="accent"
        className="gap-3 px-8 py-4 font-mono text-sm font-bold uppercase"
        onClick={() => {
          if (data.installUrl != null) {
            window.open(data.installUrl, "_blank");
          }
        }}
        disabled={data.installUrl == null}
        aria-label="onboarding-github-connect"
      >
        <GithubLogoIcon size={18} weight="bold" />
        Install GitHub App
      </Button>
    </div>
  );
}

function RepoSelectionStep({ appId }: { appId: string }) {
  const { data: repos } = useGithubRepositories();
  const { data: installation } = useGithubInstallation();
  const { data: linkedRepo } = useApplicationRepositoryFromGitHub(appId);
  const linkRepository = useLinkRepository();
  const completeGithub = useCompleteGithub();

  const navigate = useNavigate();
  const [selectedRepoId, setSelectedRepoId] = useState<number | undefined>();
  const [configured, setConfigured] = useState(false);

  const selectedRepo = repos.find((r) => r.id === selectedRepoId);
  const connectedRepo = linkedRepo ?? (configured ? selectedRepo : undefined);
  const selectedRepoLinkedToOtherApp =
    selectedRepo?.applicationId != null && selectedRepo.applicationId !== appId ? selectedRepo : undefined;
  const isLinking = linkRepository.isPending;
  const isCompleting = completeGithub.isPending;
  const settingsUrl = installation?.settingsUrl;

  function handleLinkRepo() {
    if (selectedRepoId == null) return;

    linkRepository.mutate(
      { applicationId: appId, githubRepoId: selectedRepoId },
      {
        onSuccess: () => {
          setConfigured(true);
        },
      },
    );
  }

  function handleComplete() {
    completeGithub.mutate(
      { applicationId: appId },
      {
        onSuccess: () => {
          void navigate({ to: "/onboarding", search: buildOnboardingSearch("preview-environment", appId) });
        },
      },
    );
  }

  if (connectedRepo != null) {
    return (
      <div className="space-y-8">
        <div className="flex items-center gap-3 rounded border border-status-success/20 bg-status-success/5 px-5 py-4">
          <CheckCircleIcon size={20} weight="fill" className="text-status-success" />
          <div>
            <p className="text-sm font-medium text-text-primary">{connectedRepo.fullName} connected</p>
            <p className="font-mono text-2xs text-text-secondary">
              Default branch: <span className="text-text-primary">{connectedRepo.defaultBranch}</span>
            </p>
          </div>
        </div>

        <Button
          variant="accent"
          className="gap-3 px-8 py-4 font-mono text-sm font-bold uppercase"
          onClick={handleComplete}
          disabled={isCompleting}
          aria-label="onboarding-github-complete"
        >
          {isCompleting ? "continuing..." : "Continue"}
          <ArrowRightIcon size={18} weight="bold" />
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-1.5">
        <Label>Repository</Label>
        <Select
          value={selectedRepoId != null ? String(selectedRepoId) : ""}
          onValueChange={(value) => {
            const numValue = Number(value);
            linkRepository.reset();
            setSelectedRepoId(!Number.isNaN(numValue) ? numValue : undefined);
          }}
        >
          <SelectTrigger className="max-w-lg">
            <SelectValue placeholder="Select a repository">{selectedRepo?.fullName}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {repos.map((repo) => {
              const isLinkedToOtherApp = repo.applicationId != null && repo.applicationId !== appId;
              return (
                <SelectItem key={repo.id} value={String(repo.id)} disabled={isLinkedToOtherApp}>
                  {isLinkedToOtherApp
                    ? `${repo.fullName} (linked to ${repo.applicationName ?? "another app"})`
                    : repo.fullName}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
        {selectedRepoLinkedToOtherApp != null && (
          <div className="mt-2 flex max-w-lg items-start gap-2 rounded border border-status-warn/20 bg-status-warn/5 px-3 py-2">
            <WarningCircleIcon size={14} weight="fill" className="mt-0.5 shrink-0 text-status-warn" />
            <p className="font-mono text-2xs text-text-secondary">
              {selectedRepoLinkedToOtherApp.fullName} is already linked to{" "}
              {selectedRepoLinkedToOtherApp.applicationName ?? "another application"}. Choose an unlinked repository or
              continue from that application.
            </p>
          </div>
        )}
        {linkRepository.error != null && (
          <div className="mt-2 flex max-w-lg items-start gap-2 rounded border border-status-critical/30 bg-status-critical/5 px-3 py-2">
            <WarningCircleIcon size={14} weight="fill" className="mt-0.5 shrink-0 text-status-critical" />
            <p className="font-mono text-2xs text-status-critical">{linkRepository.error.message}</p>
          </div>
        )}
        {settingsUrl != null && (
          <p className="font-mono text-2xs text-text-secondary">
            Can't find your repository?{" "}
            <a
              href={settingsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary-ink underline underline-offset-2 transition-colors hover:text-primary-ink/80"
            >
              Configure repository access on GitHub
            </a>
          </p>
        )}
      </div>

      <Button
        variant="accent"
        className="gap-3 px-8 py-4 font-mono text-sm font-bold uppercase"
        onClick={handleLinkRepo}
        disabled={selectedRepoId == null || selectedRepoLinkedToOtherApp != null || isLinking}
        aria-label="onboarding-github-link"
      >
        {isLinking ? "linking..." : "Link Repository"}
        <ArrowRightIcon size={18} weight="bold" />
      </Button>
    </div>
  );
}
