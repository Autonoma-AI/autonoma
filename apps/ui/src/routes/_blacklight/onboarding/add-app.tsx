import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  cn,
} from "@autonoma/blacklight";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { GithubLogoIcon } from "@phosphor-icons/react/GithubLogo";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Navigate, createFileRoute, useNavigate } from "@tanstack/react-router";
import { DeleteApplicationDialog } from "components/delete-application-dialog";
import { useCompleteGithub } from "lib/onboarding/onboarding-api";
import { buildOnboardingSearch } from "lib/onboarding/onboarding-search";
import { useCreateMinimalApplication } from "lib/query/applications.queries";
import {
  useGithubConfig,
  useGithubInstallation,
  useGithubRepositories,
  useLinkRepository,
} from "lib/query/github.queries";
import { trpc } from "lib/trpc";
import { Component, Suspense, useState, type ReactNode } from "react";
import { z } from "zod";
import { OnboardingPageHeader } from "./-components/onboarding-page-header";

const addAppSearchParams = z.object({
  appId: z.string().optional(),
  error: z.string().optional(),
});

export const Route = createFileRoute("/_blacklight/onboarding/add-app")({
  component: RouteComponent,
  validateSearch: addAppSearchParams,
});

function RouteComponent() {
  const { appId, error } = Route.useSearch();
  return <Navigate to="/onboarding" search={buildOnboardingSearch("add-app", appId, { error })} />;
}

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function repoShortName(fullName: string): string {
  return fullName.split("/").pop() ?? fullName;
}

export function AddAppPage({ appId, error }: { appId?: string; error?: string }) {
  return (
    <>
      <OnboardingPageHeader
        leading={
          <div className="mb-4 flex size-12 items-center justify-center rounded-full border border-primary-ink/20 bg-surface-base">
            <GithubLogoIcon size={22} weight="duotone" className="text-primary-ink" />
          </div>
        }
        title="Add your app"
        description={<p className="max-w-2xl">Connect the repository Autonoma will deploy and review.</p>}
        descriptionClassName="text-sm"
      />

      {error != null && (
        <div className="mb-8 flex items-start gap-3 border border-status-critical/30 bg-status-critical/5 px-5 py-4">
          <WarningCircleIcon size={20} weight="fill" className="mt-0.5 shrink-0 text-status-critical" />
          <p className="font-mono text-sm text-status-critical">{getErrorMessage(error)}</p>
        </div>
      )}

      <AddAppErrorBoundary>
        <Suspense fallback={<AddAppSkeleton />}>
          <AddAppContent appId={appId} />
        </Suspense>
      </AddAppErrorBoundary>
    </>
  );
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

function AddAppSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-12 w-full max-w-lg" />
      <Skeleton className="h-12 w-full max-w-md" />
      <Skeleton className="h-10 w-48" />
    </div>
  );
}

class AddAppErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
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

function AddAppContent({ appId }: { appId?: string }) {
  const { data: installation } = useGithubInstallation();
  const { data: repos } = useGithubRepositories();

  if (installation == null || repos.length === 0) {
    return <InstallStep appId={appId} hasStaleInstallation={installation != null} appSlug={installation?.appSlug} />;
  }

  return <RepoAndNameStep appId={appId} settingsUrl={installation.settingsUrl} />;
}

function InstallStep({
  appId,
  hasStaleInstallation,
  appSlug,
}: {
  appId?: string;
  hasStaleInstallation: boolean;
  appSlug?: string;
}) {
  const queryClient = useQueryClient();
  const returnPath = appId != null ? `/onboarding/add-app?appId=${encodeURIComponent(appId)}` : "/onboarding/add-app";
  const { data } = useGithubConfig(returnPath);

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: trpc.github.getInstallation.queryKey() });
    void queryClient.invalidateQueries({ queryKey: trpc.github.listRepositories.queryKey() });
  }

  return (
    <div className="space-y-6">
      <p className="max-w-2xl font-mono text-sm text-text-secondary">
        {hasStaleInstallation ? (
          <>
            No repositories are visible to the GitHub App{" "}
            {appSlug != null ? <span className="text-primary-ink">{appSlug}</span> : "this environment uses"}. Grant it
            access to the repository you want (or install it), then refresh.
          </>
        ) : (
          "Install the Autonoma GitHub App on the repository Autonoma should deploy or observe for preview environments."
        )}
      </p>

      <div className="flex flex-wrap items-center gap-3">
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
          {hasStaleInstallation ? "Configure GitHub App" : "Install GitHub App"}
        </Button>
        {hasStaleInstallation && (
          <Button variant="outline" size="sm" onClick={refresh}>
            I've installed it - refresh
          </Button>
        )}
      </div>
    </div>
  );
}

function RepoAndNameStep({ appId, settingsUrl }: { appId?: string; settingsUrl?: string }) {
  const navigate = useNavigate();
  const { data: repos } = useGithubRepositories();
  const { data: applications } = useSuspenseQuery(trpc.applications.list.queryOptions());
  const createApp = useCreateMinimalApplication();
  const linkRepository = useLinkRepository();
  const completeGithub = useCompleteGithub();

  const [selectedRepoId, setSelectedRepoId] = useState<number | undefined>();
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [conflictError, setConflictError] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const selectedRepo = repos.find((r) => r.id === selectedRepoId);
  const selectedRepoLinkedToOtherApp =
    selectedRepo?.applicationId != null && selectedRepo.applicationId !== appId ? selectedRepo : undefined;
  const linkedApp =
    selectedRepoLinkedToOtherApp?.applicationId != null && selectedRepoLinkedToOtherApp.applicationName != null
      ? { id: selectedRepoLinkedToOtherApp.applicationId, name: selectedRepoLinkedToOtherApp.applicationName }
      : undefined;
  const slug = toSlug(name.trim());
  const isNameTaken = conflictError || (slug.length > 0 && applications.some((app) => app.slug === slug));
  const isBusy = createApp.isPending || linkRepository.isPending || completeGithub.isPending;

  function selectRepo(repoId: number | undefined) {
    setSelectedRepoId(repoId);
    setConflictError(false);
    // Prefill the app name from the repo until the user types their own.
    if (!nameEdited && repoId != null) {
      const repo = repos.find((r) => r.id === repoId);
      if (repo != null) setName(repoShortName(repo.fullName));
    }
  }

  function goToPreview(applicationId: string) {
    void navigate({ to: "/onboarding", search: buildOnboardingSearch("preview-environment", applicationId) });
  }

  function linkAndContinue(applicationId: string, repoId: number) {
    linkRepository.mutate(
      { applicationId, githubRepoId: repoId },
      {
        onSuccess: () => {
          completeGithub.mutate({ applicationId }, { onSuccess: () => goToPreview(applicationId) });
        },
      },
    );
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (selectedRepoId == null || selectedRepoLinkedToOtherApp != null || isBusy) return;

    if (appId != null) {
      linkAndContinue(appId, selectedRepoId);
      return;
    }

    if (name.trim().length === 0 || isNameTaken) return;
    createApp.mutate(
      { name: name.trim() },
      {
        onSuccess: (data) => linkAndContinue(data.id, selectedRepoId),
        onError: (error) => {
          if (error.data?.code === "CONFLICT") setConflictError(true);
        },
      },
    );
  }

  return (
    <>
      <form onSubmit={handleSubmit} className="flex max-w-lg flex-col gap-8">
        <div className="flex flex-col gap-1.5">
          <Label>Repository</Label>
          <Select
            value={selectedRepoId != null ? String(selectedRepoId) : ""}
            onValueChange={(value) => {
              const numValue = Number(value);
              linkRepository.reset();
              selectRepo(!Number.isNaN(numValue) ? numValue : undefined);
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select a repository">{selectedRepo?.fullName}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {repos.map((repo) => {
                const isLinkedToOtherApp = repo.applicationId != null && repo.applicationId !== appId;
                return (
                  <SelectItem key={repo.id} value={String(repo.id)}>
                    {isLinkedToOtherApp
                      ? `${repo.fullName} (linked to ${repo.applicationName ?? "another app"})`
                      : repo.fullName}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
          {selectedRepoLinkedToOtherApp != null && (
            <div className="mt-2 flex flex-col gap-2 rounded border border-status-warn/20 bg-status-warn/5 px-3 py-2">
              <div className="flex items-start gap-2">
                <WarningCircleIcon size={14} weight="fill" className="mt-0.5 shrink-0 text-status-warn" />
                <p className="font-mono text-2xs text-text-secondary">
                  {selectedRepoLinkedToOtherApp.fullName} is already linked to{" "}
                  {selectedRepoLinkedToOtherApp.applicationName ?? "another application"}.{" "}
                  {linkedApp != null
                    ? "Delete that application to free the repository, or choose another repository."
                    : "Choose an unlinked repository."}
                </p>
              </div>
              {linkedApp != null && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-fit"
                  onClick={() => setDeleteDialogOpen(true)}
                  aria-label="onboarding-delete-linked-app"
                >
                  Delete {linkedApp.name}
                </Button>
              )}
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

        {appId == null && selectedRepoId != null && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="app-name">Application name</Label>
            <Input
              id="app-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameEdited(true);
                setConflictError(false);
              }}
              placeholder="my-web-app"
              className={cn(isNameTaken && "border-status-critical focus-visible:ring-status-critical")}
            />
            {isNameTaken ? (
              <p className="font-mono text-3xs text-status-critical">
                An application named "{slug}" already exists. Choose a different name.
              </p>
            ) : (
              <p className="font-mono text-3xs text-text-secondary">Defaults to the repository name.</p>
            )}
          </div>
        )}

        {linkRepository.error != null && (
          <div className="flex items-start gap-2 rounded border border-status-critical/30 bg-status-critical/5 px-3 py-2">
            <WarningCircleIcon size={14} weight="fill" className="mt-0.5 shrink-0 text-status-critical" />
            <p className="font-mono text-2xs text-status-critical">{linkRepository.error.message}</p>
          </div>
        )}

        <Button
          type="submit"
          variant="accent"
          className="w-fit gap-3 px-8 py-4 font-mono text-sm font-bold uppercase"
          disabled={
            selectedRepoId == null ||
            selectedRepoLinkedToOtherApp != null ||
            isBusy ||
            (appId == null && (name.trim().length === 0 || isNameTaken))
          }
          aria-label="onboarding-add-app-submit"
        >
          {isBusy ? "Adding..." : "Add app"}
          <ArrowRightIcon size={18} weight="bold" />
        </Button>
      </form>
      {linkedApp != null && (
        <DeleteApplicationDialog
          open={deleteDialogOpen}
          onOpenChange={setDeleteDialogOpen}
          applicationId={linkedApp.id}
          applicationName={linkedApp.name}
          onDeleted={() => linkRepository.reset()}
        />
      )}
    </>
  );
}
