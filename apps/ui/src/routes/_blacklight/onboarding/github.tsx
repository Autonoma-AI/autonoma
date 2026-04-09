import { Button, Skeleton } from "@autonoma/blacklight";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { GithubLogoIcon } from "@phosphor-icons/react/GithubLogo";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  useGithubConfig,
  useGithubInstallation,
  useGithubRepositories,
  useUpdateRepoConfig,
} from "lib/query/github.queries";
import { useCompleteGithub } from "lib/query/onboarding.queries";
import { Suspense, useState } from "react";
import { z } from "zod";

const githubSearchParams = z.object({
  appId: z.string(),
  error: z.string().optional(),
});

export const Route = createFileRoute("/_blacklight/onboarding/github")({
  component: GitHubPage,
  validateSearch: githubSearchParams,
});

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

function GitHubPage() {
  const { error, appId } = Route.useSearch();

  return (
    <div className="py-16">
      <header className="mb-10 border-b border-border-dim pb-8">
        <div className="mb-4 flex size-12 items-center justify-center rounded-full border border-primary-ink/20 bg-surface-base">
          <GithubLogoIcon size={22} weight="duotone" className="text-primary-ink" />
        </div>
        <h1 className="text-4xl font-medium tracking-tight text-text-primary">Connect GitHub</h1>
        <p className="mt-3 font-mono text-sm text-text-secondary">
          Link a repository so Autonoma can analyze code changes and keep your tests up to date.
        </p>
      </header>

      {error != null && (
        <div className="mb-8 flex items-start gap-3 border border-status-critical/30 bg-status-critical/5 px-5 py-4">
          <WarningCircleIcon size={20} weight="fill" className="mt-0.5 shrink-0 text-status-critical" />
          <p className="font-mono text-sm text-status-critical">{getErrorMessage(error)}</p>
        </div>
      )}

      <Suspense fallback={<GitHubContentSkeleton />}>
        <GitHubContent appId={appId} />
      </Suspense>
    </div>
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
        Install the Autonoma GitHub App on your repository to enable automatic test updates when code changes.
      </p>

      <Button
        variant="accent"
        className="gap-3 px-8 py-4 font-mono text-sm font-bold uppercase"
        onClick={() => {
          if (data.installUrl != null) {
            window.location.href = data.installUrl;
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
  const updateRepoConfig = useUpdateRepoConfig();
  const completeGithub = useCompleteGithub(appId);

  const navigate = useNavigate();
  const [selectedRepoId, setSelectedRepoId] = useState<string | undefined>();
  const [watchBranch, setWatchBranch] = useState("main");
  const [configured, setConfigured] = useState(false);

  const selectedRepo = repos.find((r) => r.id === selectedRepoId);
  const isLinking = updateRepoConfig.isPending;
  const isCompleting = completeGithub.isPending;
  const settingsUrl = installation?.settingsUrl;

  function handleLinkRepo() {
    if (selectedRepoId == null) return;

    updateRepoConfig.mutate(
      { repoId: selectedRepoId, watchBranch, deploymentTrigger: "push", applicationId: appId },
      {
        onSuccess: () => {
          setConfigured(true);
        },
      },
    );
  }

  function handleComplete() {
    completeGithub.mutate(undefined, {
      onSuccess: () => {
        void navigate({ to: "/onboarding/complete", search: { appId } });
      },
    });
  }

  if (configured) {
    return (
      <div className="space-y-8">
        <div className="flex items-center gap-3 rounded border border-status-success/20 bg-status-success/5 px-5 py-4">
          <CheckCircleIcon size={20} weight="fill" className="text-status-success" />
          <div>
            <p className="text-sm font-medium text-text-primary">{selectedRepo?.fullName ?? "Repository"} connected</p>
            <p className="font-mono text-2xs text-text-secondary">
              Watching branch <span className="text-text-primary">{watchBranch}</span>
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
          {isCompleting ? "finishing..." : "Complete Setup"}
          <ArrowRightIcon size={18} weight="bold" />
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="repo-select" className="font-mono text-2xs uppercase tracking-widest text-text-tertiary">
          Repository
        </label>
        <select
          id="repo-select"
          value={selectedRepoId ?? ""}
          onChange={(e) => {
            setSelectedRepoId(e.target.value || undefined);
            const repo = repos.find((r) => r.id === e.target.value);
            if (repo?.defaultBranch != null) {
              setWatchBranch(repo.defaultBranch);
            }
          }}
          className="w-full max-w-lg border border-border-dim bg-surface-base px-4 py-2.5 font-mono text-sm text-text-primary outline-none focus:border-primary-ink/50"
        >
          <option value="">Select a repository</option>
          {repos.map((repo) => (
            <option key={repo.id} value={repo.id}>
              {repo.fullName}
            </option>
          ))}
        </select>
        {settingsUrl != null && (
          <p className="font-mono text-2xs text-text-tertiary">
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

      {selectedRepoId != null && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="branch-input" className="font-mono text-2xs uppercase tracking-widest text-text-tertiary">
            Branch to watch
          </label>
          <input
            id="branch-input"
            type="text"
            value={watchBranch}
            onChange={(e) => setWatchBranch(e.target.value)}
            className="w-full max-w-lg border border-border-dim bg-surface-base px-4 py-2.5 font-mono text-sm text-text-primary placeholder-text-tertiary/50 outline-none focus:border-primary-ink/50"
          />
          <p className="font-mono text-2xs text-text-tertiary">Autonoma will analyze changes pushed to this branch.</p>
        </div>
      )}

      <Button
        variant="accent"
        className="gap-3 px-8 py-4 font-mono text-sm font-bold uppercase"
        onClick={handleLinkRepo}
        disabled={selectedRepoId == null || watchBranch.length === 0 || isLinking}
        aria-label="onboarding-github-link"
      >
        {isLinking ? "linking..." : "Link Repository"}
        <ArrowRightIcon size={18} weight="bold" />
      </Button>
    </div>
  );
}
