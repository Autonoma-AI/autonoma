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
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { GithubLogoIcon } from "@phosphor-icons/react/GithubLogo";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Navigate, createFileRoute, useNavigate } from "@tanstack/react-router";
import { DeleteApplicationDialog } from "components/delete-application-dialog";
import { InstallFailureBanner } from "components/install-failure-banner";
import { getApiOrigin } from "lib/api-origin";
import {
  installActionLabel,
  installFailureBlocksRetry,
  installLeadOverride,
  manageUrlSchema,
} from "lib/github-install-errors";
import { useCompleteGithub } from "lib/onboarding/onboarding-api";
import { type OnboardingOrigin, buildOnboardingSearch } from "lib/onboarding/onboarding-search";
import { useCreateMinimalApplication } from "lib/query/applications.queries";
import { useActiveOrg } from "lib/query/auth.queries";
import {
  useGithubConfig,
  useGithubInstallation,
  useGithubRepositories,
  useGithubRepositoryListing,
  useLinkRepository,
} from "lib/query/github.queries";
import { trpc } from "lib/trpc";
import { Component, Suspense, useState, type ReactNode } from "react";
import { z } from "zod";
import { OnboardingPageHeader } from "./-components/onboarding-page-header";

/** What the install callback hands back on failure, threaded to whichever step renders it. */
interface InstallFailureProps {
  error: string;
  account?: string;
  attempted?: string;
  manageUrl?: string;
}

const addAppSearchParams = z.object({
  appId: z.string().optional(),
  error: z.string().optional(),
  account: z.string().optional(),
  attempted: z.string().optional(),
  manageUrl: manageUrlSchema,
});

export const Route = createFileRoute("/_blacklight/onboarding/add-app")({
  component: RouteComponent,
  validateSearch: addAppSearchParams,
});

function RouteComponent() {
  const { appId, error, account, attempted, manageUrl } = Route.useSearch();
  return (
    <Navigate
      to="/onboarding"
      search={buildOnboardingSearch("add-app", appId, { error, account, attempted, manageUrl })}
    />
  );
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

export function AddAppPage({
  appId,
  error,
  account,
  attempted,
  manageUrl,
  origin,
}: {
  appId?: string;
  error?: string;
  /** GitHub account already connected, when `error` is an install conflict. */
  account?: string;
  /** GitHub account the user tried to add, when `error` is an install conflict. */
  attempted?: string;
  /** GitHub page for the installation the steps tell the user to uninstall. */
  manageUrl?: string;
  origin?: OnboardingOrigin;
}) {
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

      <AddAppErrorBoundary>
        <Suspense fallback={<AddAppSkeleton />}>
          <AddAppContent
            appId={appId}
            origin={origin}
            failure={error != null ? { error, account, attempted, manageUrl } : undefined}
          />
        </Suspense>
      </AddAppErrorBoundary>
    </>
  );
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

function AddAppContent({
  appId,
  origin,
  failure,
}: {
  appId?: string;
  origin?: OnboardingOrigin;
  failure?: InstallFailureProps;
}) {
  const { data: installation } = useGithubInstallation();
  const { data: listing } = useGithubRepositoryListing();
  const repos = listing.repos;

  // Every state this screen can be in, resolved once. Each one has to name an action that works:
  // the bugs here were all a state falling through to a button pointing somewhere it should not.
  //
  // `unavailable` means GitHub would not say what the installation can see - the shape of one
  // uninstalled without us hearing about it - so it counts as no installation rather than as one
  // to configure, which would be a 404. A `deleted` installation never reaches here at all; the
  // API reports it absent.
  const suspended = installation != null && installation.status === "suspended";
  const usable = installation != null && !suspended && listing.unavailable == null;

  if (suspended || !usable || repos.length === 0) {
    return (
      <InstallStep
        appId={appId}
        hasStaleInstallation={usable}
        suspendedAccount={suspended ? installation.accountLogin : undefined}
        appSlug={installation?.appSlug}
        failure={failure}
        conflictStillApplies={usable && installation.status === "active"}
        // A suspended installation still exists on GitHub, so its page is a real destination -
        // and the only one that can lift the suspension.
        configureUrl={suspended || usable ? installation?.settingsUrl : undefined}
      />
    );
  }

  return (
    <>
      {failure != null && <InstallFailureBanner {...failure} className="mb-8" />}
      <RepoAndNameStep appId={appId} settingsUrl={installation.settingsUrl} origin={origin} />
    </>
  );
}

function InstallStep({
  appId,
  hasStaleInstallation,
  suspendedAccount,
  appSlug,
  failure,
  conflictStillApplies,
  configureUrl,
}: {
  appId?: string;
  hasStaleInstallation: boolean;
  /** Account whose installation GitHub has suspended, when that is the blocker. */
  suspendedAccount?: string;
  appSlug?: string;
  failure?: InstallFailureProps;
  /**
   * Whether a live installation still stands in the way. Live data, not the `error` query param:
   * the param survives in the URL after the user follows the steps and uninstalls on GitHub, so
   * deriving `blocked` from it alone left them staring at a permanently dead Install button.
   */
  conflictStillApplies?: boolean;
  /**
   * The connected installation's own page on GitHub. Used INSTEAD of the install URL once an
   * installation exists: the install URL is GitHub's account picker, so "Configure GitHub App"
   * was handing someone who just wanted to grant more repository access the shortest path to
   * installing on a second account - the very thing the conflict below then refuses.
   */
  configureUrl?: string;
}) {
  const returnPath = appId != null ? `/onboarding/add-app?appId=${encodeURIComponent(appId)}` : "/onboarding/add-app";
  const { data } = useGithubConfig(returnPath);
  // `returnTo` is what "Back to your account" in the demo comes back to - this step, not
  // the app root, so the visitor picks up at the install button they left.
  const demoUrl = `${getApiOrigin()}/v1/demo?source=onboarding&returnTo=${encodeURIComponent(returnPath)}`;
  // Blocking exists for the account PICKER: after a conflict, picking another account again just
  // earns the same refusal. It must never block the configure path - that opens the connected
  // installation's own page on GitHub, which is where you grant it repositories and is the way OUT
  // of this state. Disabling it left the conflict banner pointing at a button it had switched off.
  const blocked =
    configureUrl == null &&
    failure != null &&
    installFailureBlocksRetry(failure.error) &&
    conflictStillApplies === true;
  // When the app is already installed, "Install GitHub App" tells the user to redo what they just
  // did. The action is linking, and both the button and the lead say so.
  const actionLabel = installActionLabel(failure?.error);
  const leadOverride = installLeadOverride(failure?.error);

  return (
    <div className="space-y-6">
      <p className="max-w-2xl font-mono text-sm text-text-secondary">
        {leadOverride != null ? (
          leadOverride
        ) : suspendedAccount != null ? (
          <>
            GitHub has suspended the Autonoma app on <span className="text-primary-ink">{suspendedAccount}</span>, so
            Autonoma cannot read anything from it. Unsuspend it on GitHub - nothing here needs reinstalling - then
            reload this page.
          </>
        ) : hasStaleInstallation ? (
          <>
            No repositories are visible to the GitHub App{" "}
            {appSlug != null ? <span className="text-primary-ink">{appSlug}</span> : "this environment uses"}. Grant it
            access to every repository your application needs - the frontend plus any backend, API, or worker repos -
            then reload this page.
          </>
        ) : (
          "Install the Autonoma GitHub App and grant it access to every repository your application needs to run - the frontend plus any backend, API, or worker repos. They deploy together into one preview environment, so add them all, not just one."
        )}
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="accent"
          className="gap-3 px-8 py-4 font-mono text-sm font-bold uppercase"
          onClick={() => {
            const target = configureUrl ?? data.installUrl;
            if (target != null) {
              window.open(target, "_blank");
            }
          }}
          disabled={(configureUrl ?? data.installUrl) == null || blocked}
          aria-label="onboarding-github-connect"
        >
          <GithubLogoIcon size={18} weight="bold" />
          {actionLabel ??
            (suspendedAccount != null
              ? "Unsuspend on GitHub"
              : hasStaleInstallation
                ? "Configure GitHub App"
                : "Install GitHub App")}
        </Button>
        <Button
          variant="outline"
          className="gap-3 px-8 py-4 font-mono text-sm font-bold uppercase"
          render={<a href={demoUrl} target="_blank" rel="noopener noreferrer" />}
          aria-label="onboarding-view-demo"
        >
          View demo
          <ArrowSquareOutIcon size={16} weight="bold" />
        </Button>
      </div>
      {/* Below the button, not above it: the button is what the message is about, and the one
          case that lands here most often is fixed by pressing it. */}
      {failure != null && <InstallFailureBanner {...failure} className="max-w-2xl" />}

      <p className="max-w-2xl font-mono text-2xs text-text-secondary">
        The demo opens in a new tab as a read-only guest, which signs this tab out until you come back - your setup is
        saved, and "Back to your account" in the demo returns you here.
      </p>
    </div>
  );
}

function RepoAndNameStep({
  appId,
  settingsUrl,
  origin,
}: {
  appId?: string;
  settingsUrl?: string;
  origin?: OnboardingOrigin;
}) {
  const navigate = useNavigate();
  const { data: repos } = useGithubRepositories();
  const { data: applications } = useSuspenseQuery(trpc.applications.list.queryOptions());
  const createApp = useCreateMinimalApplication();
  const linkRepository = useLinkRepository();
  const completeGithub = useCompleteGithub();
  // The demo shows a real org's installation; don't send visitors out to its GitHub
  // settings page.
  const isDemo = useActiveOrg().data?.isDemo === true;

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
  const isBusy = createApp.isPending || linkRepository.isPending || completeGithub.isPending;
  // Once we start creating the app, stop running the client-side "name already
  // exists" pre-check: on success the applications list refetches and now holds
  // the app we just created, which would otherwise flash a false "already exists"
  // error while we navigate to the next step. `conflictError` (a real server
  // CONFLICT) still surfaces.
  const submitting = isBusy || createApp.isSuccess;
  const nameCollidesWithExisting = slug.length > 0 && applications.some((app) => app.slug === slug);
  const isNameTaken = conflictError || (!submitting && nameCollidesWithExisting);

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
    void navigate({
      to: "/onboarding",
      search: buildOnboardingSearch("preview-environment", applicationId, { origin }),
    });
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
          {settingsUrl != null && !isDemo && (
            <p className="font-mono text-2xs text-text-secondary">
              Can't find your repository?{" "}
              <a
                href={settingsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary-ink underline underline-offset-2 transition-colors hover:text-primary-ink/80"
              >
                Grant access to it on GitHub
              </a>
              . Autonoma connects one GitHub account per workspace, so a repository under a different account has to be
              shared with this installation.
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
