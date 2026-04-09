import { Badge, Button, Panel, PanelBody, PanelHeader, PanelTitle, Separator, Skeleton } from "@autonoma/blacklight";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { GithubLogoIcon } from "@phosphor-icons/react/GithubLogo";
import { LinkBreakIcon } from "@phosphor-icons/react/LinkBreak";
import { PencilSimpleIcon } from "@phosphor-icons/react/PencilSimple";
import { createFileRoute } from "@tanstack/react-router";
import {
  useDisconnectGithub,
  useGithubConfig,
  useGithubInstallation,
  useGithubRepositories,
  useUpdateRepoConfig,
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
  const app = useCurrentApplication();
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
        <RepositoriesPanel settingsUrl={installation.settingsUrl} applicationId={app.id} />
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
            <p className="text-xs text-status-critical">This will remove all linked repositories. Are you sure?</p>
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
            <a
              href={settingsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded px-3 py-1.5 text-xs text-text-tertiary transition-colors hover:bg-surface-raised hover:text-text-secondary"
            >
              <ArrowSquareOutIcon size={14} />
              Manage on GitHub
            </a>
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

function RepositoriesPanel({ settingsUrl, applicationId }: { settingsUrl: string; applicationId: string }) {
  const { data: repos } = useGithubRepositories();

  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>Repositories</PanelTitle>
      </PanelHeader>
      <PanelBody>
        {repos.length === 0 ? (
          <p className="text-xs text-text-tertiary">No repositories linked yet.</p>
        ) : (
          <div className="divide-y divide-border-dim">
            {repos.map((repo) => (
              <RepoRow key={repo.id} repo={repo} applicationId={applicationId} />
            ))}
          </div>
        )}
        <p className="mt-4 font-mono text-2xs text-text-tertiary">
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
      </PanelBody>
    </Panel>
  );
}

function RepoRow({
  repo,
  applicationId,
}: {
  repo: { id: string; fullName: string; watchBranch: string | null; deploymentTrigger: string | null };
  applicationId: string;
}) {
  const updateRepoConfig = useUpdateRepoConfig();
  const [editing, setEditing] = useState(false);
  const [watchBranch, setWatchBranch] = useState(repo.watchBranch ?? "main");

  function handleSave() {
    updateRepoConfig.mutate(
      {
        repoId: repo.id,
        watchBranch,
        deploymentTrigger: (repo.deploymentTrigger as "push" | "github_action") ?? "push",
        applicationId,
      },
      { onSuccess: () => setEditing(false) },
    );
  }

  return (
    <div className="flex items-center justify-between py-3">
      <div>
        <p className="text-sm font-medium text-text-primary">{repo.fullName}</p>
        {editing ? (
          <div className="mt-2 flex items-center gap-2">
            <input
              type="text"
              value={watchBranch}
              onChange={(e) => setWatchBranch(e.target.value)}
              className="border border-border-dim bg-surface-base px-3 py-1.5 font-mono text-xs text-text-primary outline-none focus:border-primary-ink/50"
            />
            <Button size="xs" onClick={handleSave} disabled={updateRepoConfig.isPending}>
              Save
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <p className="font-mono text-2xs text-text-tertiary">
            watching <span className="text-text-secondary">{repo.watchBranch ?? "not configured"}</span>
          </p>
        )}
      </div>
      {!editing && (
        <Button variant="ghost" size="icon-xs" onClick={() => setEditing(true)}>
          <PencilSimpleIcon size={14} />
        </Button>
      )}
    </div>
  );
}
