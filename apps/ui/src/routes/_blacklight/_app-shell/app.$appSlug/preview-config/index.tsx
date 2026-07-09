import { Button, Skeleton } from "@autonoma/blacklight";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { createFileRoute } from "@tanstack/react-router";
import { Suspense, useState } from "react";
import { MultirepoSection } from "../../../onboarding/-components/previewkit/multirepo-section";
import { PRIMARY_REPO_KEY, type TopologyDraft } from "../../../onboarding/-components/previewkit/topology-draft";
import { AppView } from "./-app-view";
import { usePreviewDraft } from "./-draft-context";
import { PreviewRail, type RailSelection } from "./-rail";
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
  const { draft } = usePreviewDraft();
  const [selection, setSelection] = useState<RailSelection | undefined>(undefined);
  const resolved = resolveSelection(selection, draft);

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-stretch">
      <PreviewRail selection={resolved} onSelect={setSelection} />
      <main className="min-w-0 flex-1 lg:border-l lg:border-border-dim">
        {/* Pane-level boundary: a pane that suspends (Repos fetches the GitHub
            repo list on first mount) must not blank the rail with it. */}
        <Suspense fallback={<SelectionPaneSkeleton />}>
          <SelectionPane selection={resolved} onSelect={setSelection} />
        </Suspense>
      </main>
    </div>
  );
}

/**
 * Resolves the raw rail selection against the current draft: a deleted app or
 * service falls back to the default destination (primary app, then first app,
 * then first service), mirroring the design's "an app is always in focus".
 */
function resolveSelection(selection: RailSelection | undefined, draft: TopologyDraft): RailSelection | undefined {
  if (selection?.kind === "repos") return selection;
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

  if (selection.kind === "repos") {
    return (
      <div className="lg:pl-6">
        <ReposPane />
      </div>
    );
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

/** Dependency-repo topology and branch conventions, unchanged from onboarding. */
function ReposPane() {
  const { draft, primaryRepoFullName, appCountByRepoKey, setRepos, setBranchConvention } = usePreviewDraft();
  return (
    <MultirepoSection
      repos={draft.repos}
      branchConvention={draft.branchConvention}
      primaryRepoFullName={primaryRepoFullName}
      appCountByRepoKey={appCountByRepoKey}
      onReposChange={setRepos}
      onBranchConventionChange={setBranchConvention}
    />
  );
}
