import { Button, Skeleton } from "@autonoma/blacklight";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { RobotIcon } from "@phosphor-icons/react/Robot";
import { createFileRoute } from "@tanstack/react-router";
import { ConnectAgentDialog, DEBUG_MCP_DOCS_URL } from "components/connect-agent-dialog";
import { Suspense, useState } from "react";
import { AddAppDialog } from "../../../onboarding/-components/previewkit/add-app-dialog";
import { PRIMARY_REPO_KEY, type TopologyDraft } from "../../../onboarding/-components/previewkit/topology-draft";
import { AppView } from "./-app-view";
import { usePreviewDraft } from "./-draft-context";
import { PreviewRail, type RailSelection } from "./-rail";
import { RepoView } from "./-repo-view";
import { ServiceView } from "./-service-view";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/preview-config/")({
  component: PreviewConfigPage,
});

/**
 * The Preview Environments workspace (design "5a"): an app-centric rail on the
 * left and one pane on the right for whatever it points at - an app (overview +
 * variables), a managed service (overview + settings), or the cross-cutting
 * repo/hook config. Selection is draft-local state: rail entries are unsaved
 * draft entities, so they have no stable address to put in the URL.
 */
function PreviewConfigPage() {
  const { draft, addApp, addAppFromNewRepo, primaryRepoFullName } = usePreviewDraft();
  const [selection, setSelection] = useState<RailSelection | undefined>(undefined);
  const [addAppOpen, setAddAppOpen] = useState(false);
  const resolved = resolveSelection(selection, draft);

  return (
    <div className="flex flex-col gap-6">
      <ConfigureWithAgentPanel />
      <div className="flex flex-col gap-6 lg:flex-row lg:items-stretch">
        <PreviewRail selection={resolved} onSelect={setSelection} onAddFromAnotherRepo={() => setAddAppOpen(true)} />
        <main className="min-w-0 flex-1 lg:border-l lg:border-border-dim">
          {/* Pane-level boundary: a pane that suspends (Repos fetches the GitHub
              repo list on first mount) must not blank the rail with it. */}
          <Suspense fallback={<SelectionPaneSkeleton />}>
            <SelectionPane selection={resolved} onSelect={setSelection} />
          </Suspense>
        </main>
      </div>
      {/* Mounted only while open: the dialog reads the GitHub repo list and install
          config via useSuspenseQuery, so mounting it unconditionally would suspend
          this whole route and blank the rail on every settings-page load. Its own
          Suspense boundary keeps the open-time fetch from bubbling up to the route. */}
      {addAppOpen ? (
        <Suspense fallback={undefined}>
          <AddAppDialog
            open
            onOpenChange={setAddAppOpen}
            primaryRepoFullName={primaryRepoFullName}
            repos={draft.repos}
            onAddToExistingRepo={(alias) => setSelection({ kind: "app", id: addApp(alias) })}
            onAddToNewRepo={(repo) => setSelection({ kind: "app", id: addAppFromNewRepo(repo) })}
          />
        </Suspense>
      ) : undefined}
    </div>
  );
}

/**
 * Hand this app's preview config off to a coding agent: point it at the debug MCP
 * (keyed by the repo the agent already sits in, so no pairing code) and it can
 * read a PR's preview and edit the build/services/env from inside the repo.
 */
function ConfigureWithAgentPanel() {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-4 border border-primary/40 bg-primary/[0.06] p-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-col gap-1">
        <span className="font-sans text-base text-text-primary">Configure previews with a coding agent</span>
        <span className="max-w-xl text-2xs text-text-secondary">
          Point Claude Code, Cursor, or any MCP agent at Autonoma. From inside your repo it reads a pull request's live
          preview - deploy status, logs, missing secrets - and edits the build, services, and environment. These
          settings apply to every preview of this app, not a single PR.
        </span>
      </div>
      <Button variant="accent" size="lg" className="shrink-0" onClick={() => setOpen(true)}>
        <RobotIcon weight="bold" />
        Configure with coding agent
      </Button>
      <ConnectAgentDialog
        open={open}
        onOpenChange={setOpen}
        title="Configure with a coding agent"
        description="Install the Autonoma MCP in your coding agent. It picks up the repo and pull request from your local git and connects automatically - no pairing code to paste."
        serverName="autonoma"
        endpoint="debug"
        docsUrl={DEBUG_MCP_DOCS_URL}
        tellAgent={
          <>
            Then, from your repo, ask your agent about the preview - e.g.{" "}
            <span className="font-mono text-text-primary">why did my preview fail?</span> or{" "}
            <span className="font-mono text-text-primary">fix my preview deploy</span>. It reads the repo and PR from
            your local git.
          </>
        }
      />
    </div>
  );
}

/**
 * Resolves the raw rail selection against the current draft: a deleted app or
 * service falls back to the default destination (primary app, then first app,
 * then first service), mirroring the design's "an app is always in focus".
 */
function resolveSelection(selection: RailSelection | undefined, draft: TopologyDraft): RailSelection | undefined {
  // A repo entry only exists while its dependency repo does; if it's removed from
  // inside the pane, fall back to an app instead of stranding an orphaned pane.
  if (selection?.kind === "repo" && draft.repos.some((repo) => repo.id === selection.id)) return selection;
  if (selection?.kind === "app" && draft.apps.some((app) => app.id === selection.id)) return selection;
  if (selection?.kind === "service" && draft.services.some((service) => service.id === selection.id)) {
    return selection;
  }

  const fallbackApp = draft.apps.find((app) => app.primary) ?? draft.apps[0];
  if (fallbackApp != null) return { kind: "app", id: fallbackApp.id };
  const fallbackService = draft.services[0];
  if (fallbackService != null) return { kind: "service", id: fallbackService.id };
  return undefined;
}

function SelectionPane({
  selection,
  onSelect,
}: {
  selection?: RailSelection;
  onSelect: (selection: RailSelection) => void;
}) {
  const { draft, addApp } = usePreviewDraft();

  if (selection == null) {
    return (
      <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
        <p className="font-mono text-2xs uppercase tracking-widest text-text-secondary">No apps yet</p>
        <p className="max-w-md text-sm text-text-secondary">
          Declare the first app of this preview environment - its build wiring, variables and secrets are all managed
          here.
        </p>
        <Button
          variant="cta"
          size="sm"
          className="gap-1"
          onClick={() => onSelect({ kind: "app", id: addApp(PRIMARY_REPO_KEY) })}
        >
          <PlusIcon size={12} weight="bold" />
          New app
        </Button>
      </div>
    );
  }

  if (selection.kind === "repo") {
    const repo = draft.repos.find((candidate) => candidate.id === selection.id);
    if (repo == null) return undefined;
    return <RepoView key={repo.id} repo={repo} />;
  }

  if (selection.kind === "service") {
    const service = draft.services.find((candidate) => candidate.id === selection.id);
    if (service == null) return undefined;
    return <ServiceView key={service.id} service={service} />;
  }

  const app = draft.apps.find((candidate) => candidate.id === selection.id);
  if (app == null) return undefined;
  return <AppView key={app.id} app={app} />;
}

function SelectionPaneSkeleton() {
  return (
    <div className="flex flex-col gap-4 p-4 lg:p-6 lg:pt-4">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-72 w-full" />
    </div>
  );
}
