import { Badge, Button, Panel, PanelBody, PanelHeader, PanelTitle, Separator, Skeleton } from "@autonoma/blacklight";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { GithubLogoIcon } from "@phosphor-icons/react/GithubLogo";
import { LinkBreakIcon } from "@phosphor-icons/react/LinkBreak";
import { createFileRoute } from "@tanstack/react-router";
import { InstallFailureBanner } from "components/install-failure-banner";
import { RouteErrorState } from "components/route-error-state";
import { manageUrlSchema, singleAccountLimitNote } from "lib/github-install-errors";
import { useActiveOrg } from "lib/query/auth.queries";
import { useDisconnectGithub, useGithubConfig, useGithubInstallation } from "lib/query/github.queries";
import { Suspense, useState } from "react";
import { z } from "zod";
import { OrgScopeNote } from "../-org-scope-note";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/settings/github/")({
  // The install callback returns here with these when an install could not be completed. Without
  // them the page drops every install error on the floor: the user lands on an unchanged settings
  // page with no indication anything went wrong.
  validateSearch: z.object({
    error: z.string().optional(),
    account: z.string().optional(),
    attempted: z.string().optional(),
    // Validated, not a bare string: it is rendered as an href, and the query string is public.
    manageUrl: manageUrlSchema,
  }),
  errorComponent: ({ reset }) => (
    <RouteErrorState message="We couldn't load your GitHub App installation." reset={reset} />
  ),
  component: GitHubSettingsPage,
});

/**
 * The GitHub App installation, which is organization-wide: disconnecting it unlinks every repository from
 * every application. Which repository a single application watches is application configuration and lives in
 * that application's General settings instead.
 */
function GitHubSettingsPage() {
  const { error, account, attempted, manageUrl } = Route.useSearch();

  return (
    <div className="flex flex-col gap-4">
      <OrgScopeNote>The GitHub App is installed once.</OrgScopeNote>
      {error != null && (
        <InstallFailureBanner error={error} account={account} attempted={attempted} manageUrl={manageUrl} />
      )}
      <Suspense fallback={<GitHubSettingsSkeleton />}>
        <GitHubSettingsContent />
      </Suspense>
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

function GitHubSettingsContent() {
  const { data: installation } = useGithubInstallation();

  if (installation == null) return <NotConnectedPanel />;

  return (
    <InstallationPanel
      accountLogin={installation.accountLogin}
      status={installation.status}
      settingsUrl={installation.settingsUrl}
    />
  );
}

function NotConnectedPanel() {
  const { appSlug } = Route.useParams();
  // GitHub sends the installer back here afterwards, so the path has to name the application whose settings
  // they were in - this destination no longer has a slug-free address to fall back on.
  const { data } = useGithubConfig(`/app/${appSlug}/settings/github`);

  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>GitHub integration</PanelTitle>
      </PanelHeader>
      <PanelBody className="space-y-4">
        <p className="text-xs text-text-secondary">
          Connect a GitHub App so Autonoma can read pull requests and post its review back onto them.
        </p>
        <Button
          variant="accent"
          className="gap-2"
          onClick={() => {
            if (data.installUrl != null) window.location.href = data.installUrl;
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
  // Shared with the failure copy and gated on the same flag, so lifting the one-account limit does
  // not leave this paragraph behind asserting something that is no longer true.
  const limitNote = singleAccountLimitNote(accountLogin);

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
              <p className="font-mono text-2xs text-text-secondary">GitHub App installation</p>
            </div>
          </div>
          <Badge variant={status === "active" ? "success" : "destructive"}>{status}</Badge>
        </div>

        {limitNote != null && <p className="text-xs text-text-secondary">{limitNote}</p>}

        <Separator />

        {confirming ? (
          <div className="flex items-center gap-3">
            <p className="text-xs text-status-critical">
              This disconnects the GitHub App from your whole organization and unlinks every repository from all
              applications. To change just one application's repository, use that application's General settings. Are
              you sure?
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
                className="inline-flex items-center gap-2 rounded px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-surface-raised hover:text-text-primary"
              >
                <ArrowSquareOutIcon size={14} />
                Manage on GitHub
              </a>
            )}
            <Button variant="ghost" size="sm" className="gap-2 text-text-secondary" onClick={() => setConfirming(true)}>
              <LinkBreakIcon size={14} />
              Disconnect
            </Button>
          </div>
        )}
      </PanelBody>
    </Panel>
  );
}
