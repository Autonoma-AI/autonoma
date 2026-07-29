import {
  Badge,
  Button,
  Panel,
  PanelBody,
  PanelHeader,
  PanelTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  Skeleton,
} from "@autonoma/blacklight";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { GithubLogoIcon } from "@phosphor-icons/react/GithubLogo";
import { LinkBreakIcon } from "@phosphor-icons/react/LinkBreak";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { createFileRoute } from "@tanstack/react-router";
import { useActiveOrg } from "lib/query/auth.queries";
import {
  useDisconnectGithub,
  useGithubConfig,
  useGithubInstallation,
  useGithubRepositories,
  useLinkRepository,
  useUnlinkRepository,
} from "lib/query/github.queries";
import { Suspense, useState } from "react";
import { useCurrentApplication } from "../../-use-current-application";
import { SettingsTabNav } from "../settings/-settings-tab-nav";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/github/")({
  component: GitHubSettingsPage,
});

function GitHubSettingsPage() {
  const { appSlug } = Route.useParams();
  const returnPath = `/app/${appSlug}/github`;

  return (
    <div className="flex flex-col gap-6">
      <SettingsTabNav activeTab="github" appSlug={appSlug} />
      <div className="max-w-3xl space-y-4">
        <Suspense fallback={<GitHubSettingsSkeleton />}>
          <GitHubSettingsContent returnPath={returnPath} />
        </Suspense>
      </div>
    </div>
  );
}

function GitHubSettingsSkeleton() {
  return (
    <Panel>
      <PanelHeader>
        <Skeleton className="h-5 w-40" />
      </PanelHeader>
      <PanelBody className="space-y-4">
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-10 w-48" />
      </PanelBody>
    </Panel>
  );
}

function GitHubSettingsContent({ returnPath }: { returnPath: string }) {
  const { data: installation } = useGithubInstallation();

  if (installation == null) {
    return <NotConnectedPanel returnPath={returnPath} />;
  }

  return (
    <>
      <InstallationPanel
        accountLogin={installation.accountLogin}
        status={installation.status}
        settingsUrl={installation.settingsUrl}
      />
      <Suspense fallback={<GitHubSettingsSkeleton />}>
        <LinkedRepositoryPanel settingsUrl={installation.settingsUrl} />
      </Suspense>
    </>
  );
}

function NotConnectedPanel({ returnPath }: { returnPath: string }) {
  const { data } = useGithubConfig(returnPath);

  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>GitHub Integration</PanelTitle>
      </PanelHeader>
      <PanelBody className="space-y-4">
        <p className="text-xs text-text-secondary">
          Connect a GitHub App to enable automatic test updates when code changes are pushed.
        </p>
        <Button
          variant="accent"
          className="gap-2"
          onClick={() => {
            if (data.installUrl != null) {
              window.location.href = data.installUrl;
            }
          }}
          disabled={data.installUrl == null}
        >
          <GithubLogoIcon size={16} weight="bold" />
          Install GitHub App
        </Button>
      </PanelBody>
    </Panel>
  );
}

function InstallationPanel({
  accountLogin,
  status,
  settingsUrl,
}: {
  accountLogin: string;
  status: string;
  settingsUrl: string;
}) {
  const disconnect = useDisconnectGithub();
  const [confirming, setConfirming] = useState(false);
  // The demo shows a real org's installation; its GitHub settings page is not ours
  // to send visitors to, so drop the outbound "Manage on GitHub" link in demo mode.
  const isDemo = useActiveOrg().data?.isDemo === true;

  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>GitHub App</PanelTitle>
      </PanelHeader>
      <PanelBody className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <GithubLogoIcon size={20} weight="duotone" className="text-text-secondary" />
            <div>
              <p className="text-sm font-medium text-text-primary">{accountLogin}</p>
              <p className="font-mono text-2xs text-text-tertiary">GitHub App installation</p>
            </div>
          </div>
          <Badge variant={status === "active" ? "success" : "destructive"}>{status}</Badge>
        </div>

        <Separator />

        {confirming ? (
          <div className="flex items-center gap-3">
            <p className="text-xs text-status-critical">
              This disconnects the GitHub App from your whole organization and unlinks every repository from all
              applications. To change just this app's repository, use the Linked Repository section below. Are you sure?
            </p>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => disconnect.mutate(undefined, { onSuccess: () => setConfirming(false) })}
              disabled={disconnect.isPending}
            >
              {disconnect.isPending ? "Disconnecting..." : "Confirm"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            {!isDemo && (
              <a
                href={settingsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded px-3 py-1.5 text-xs text-text-tertiary transition-colors hover:bg-surface-raised hover:text-text-secondary"
              >
                <ArrowSquareOutIcon size={14} />
                Manage on GitHub
              </a>
            )}
            <Button variant="ghost" size="sm" className="gap-2 text-text-tertiary" onClick={() => setConfirming(true)}>
              <LinkBreakIcon size={14} />
              Disconnect
            </Button>
          </div>
        )}
      </PanelBody>
    </Panel>
  );
}

function LinkedRepositoryPanel({ settingsUrl }: { settingsUrl: string }) {
  const app = useCurrentApplication();
  const { data: repos } = useGithubRepositories();
  const linkRepository = useLinkRepository();
  const unlinkRepository = useUnlinkRepository();
  const isDemo = useActiveOrg().data?.isDemo === true;

  const linkedRepo = repos.find((r) => r.id === app.githubRepositoryId);
  const [editing, setEditing] = useState(false);
  const [selectedRepoId, setSelectedRepoId] = useState<number | undefined>();

  function handleSave() {
    if (selectedRepoId == null) return;

    linkRepository.mutate(
      { applicationId: app.id, githubRepoId: selectedRepoId },
      {
        onSuccess: () => {
          setEditing(false);
          setSelectedRepoId(undefined);
        },
      },
    );
  }

  function handleUnlink() {
    unlinkRepository.mutate({ applicationId: app.id }, { onSuccess: () => setEditing(false) });
  }

  if (linkedRepo != null && !editing) {
    return (
      <Panel>
        <PanelHeader>
          <PanelTitle>Linked Repository</PanelTitle>
        </PanelHeader>
        <PanelBody className="space-y-4">
          <div className="flex items-center gap-3">
            <CheckCircleIcon size={18} weight="fill" className="text-status-success" />
            <div>
              <p className="text-sm font-medium text-text-primary">{linkedRepo.fullName}</p>
              <p className="font-mono text-2xs text-text-tertiary">
                default branch: <span className="text-text-secondary">{linkedRepo.defaultBranch}</span>
              </p>
            </div>
          </div>

          <Separator />

          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              Change repository
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="gap-2 text-text-tertiary"
              onClick={handleUnlink}
              disabled={unlinkRepository.isPending}
            >
              <LinkBreakIcon size={14} />
              {unlinkRepository.isPending ? "Unlinking..." : "Unlink"}
            </Button>
          </div>
        </PanelBody>
      </Panel>
    );
  }

  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>{linkedRepo != null ? "Change Repository" : "Linked Repository"}</PanelTitle>
      </PanelHeader>
      <PanelBody className="space-y-5">
        {linkedRepo == null && (
          <div className="flex items-start gap-3 rounded border border-status-warn/20 bg-status-warn/5 px-4 py-3">
            <WarningCircleIcon size={16} weight="fill" className="mt-0.5 shrink-0 text-status-warn" />
            <p className="text-xs text-text-secondary">
              No repository is linked to this application. Link a repository to enable automatic test updates when code
              changes are pushed.
            </p>
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <label className="font-mono text-2xs uppercase tracking-widest text-text-tertiary">Repository</label>
          <Select
            value={selectedRepoId != null ? String(selectedRepoId) : ""}
            onValueChange={(v) => {
              if (v != null) handleRepoChange(v);
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select a repository">
                {repos.find((r) => r.id === selectedRepoId)?.fullName}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {repos.map((repo) => {
                const isLinkedToOtherApp = repo.applicationId != null && repo.applicationId !== app.id;
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
          {!isDemo && (
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

        <div className="flex items-center gap-3">
          <Button
            variant="accent"
            size="sm"
            onClick={handleSave}
            disabled={selectedRepoId == null || linkRepository.isPending}
          >
            {linkRepository.isPending ? "Saving..." : "Link Repository"}
          </Button>
          {linkedRepo != null && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setEditing(false);
                setSelectedRepoId(undefined);
              }}
            >
              Cancel
            </Button>
          )}
        </div>
      </PanelBody>
    </Panel>
  );

  function handleRepoChange(value: string) {
    const numValue = Number(value);
    if (!Number.isNaN(numValue)) {
      setSelectedRepoId(numValue);
    }
  }
}
