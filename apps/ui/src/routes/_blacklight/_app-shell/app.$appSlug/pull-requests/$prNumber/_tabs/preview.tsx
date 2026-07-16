import { Panel, PanelBody } from "@autonoma/blacklight";
import { GlobeIcon } from "@phosphor-icons/react/Globe";
import { createFileRoute, notFound } from "@tanstack/react-router";
import type { PreviewLogSource } from "components/build-logs/preview-logs-tabs";
import { ensureBranchByPrData } from "lib/query/branches.queries";
import {
  ensurePreviewEnvironmentSummaryData,
  usePreviewEnvironmentSummary,
  usePreviewSummaryById,
} from "lib/query/deployments.queries";
import { Suspense } from "react";
import { useCurrentApplication } from "routes/_blacklight/_app-shell/-use-current-application";
import {
  PreviewEnvironmentExplorer,
  PreviewEnvironmentExplorerSkeleton,
} from "../../-components/preview/preview-environment-explorer";

// Persisted in the URL so a refresh keeps the selected service and the chosen log focus (build vs app).
type PreviewSearch = { service?: string; logs?: PreviewLogSource };

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/pull-requests/$prNumber/_tabs/preview")({
  loader: async ({ context, params: { appSlug, prNumber } }) => {
    const app = context.applications.find((a) => a.slug === appSlug);
    if (app == null) throw notFound();
    await ensureBranchByPrData(context.queryClient, app.id, prNumber);
    await ensurePreviewEnvironmentSummaryData(context.queryClient, app.id, prNumber);
  },
  validateSearch: (search: Record<string, unknown>): PreviewSearch => ({
    service: typeof search.service === "string" ? search.service : undefined,
    logs: search.logs === "build" || search.logs === "app" ? search.logs : undefined,
  }),
  component: PreviewTab,
});

function PreviewTab() {
  const { prNumber } = Route.useParams();

  return (
    <div className="flex min-h-0 flex-1 flex-col p-6">
      <Suspense fallback={<PreviewEnvironmentExplorerSkeleton />}>
        <PreviewTabBody prNumber={prNumber} />
      </Suspense>
    </div>
  );
}

function PreviewTabBody({ prNumber }: { prNumber: number }) {
  const app = useCurrentApplication();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const { data: envSummary } = usePreviewEnvironmentSummary(app.id, prNumber, { refetchWhileActive: true });

  if (envSummary.source !== "previewkit") return <NoPreviewPanel />;

  return (
    <PreviewByEnvironment
      applicationId={app.id}
      environmentId={envSummary.environmentId}
      search={search}
      onSearchChange={(partial) => void navigate({ search: (prev) => ({ ...prev, ...partial }), replace: true })}
    />
  );
}

function PreviewByEnvironment({
  applicationId,
  environmentId,
  search,
  onSearchChange,
}: {
  applicationId: string;
  environmentId: string;
  search: PreviewSearch;
  onSearchChange: (partial: PreviewSearch) => void;
}) {
  const { data: summary } = usePreviewSummaryById(applicationId, environmentId, { refetchWhileActive: true });

  return (
    <PreviewEnvironmentExplorer
      applicationId={applicationId}
      environmentId={environmentId}
      summary={summary}
      search={search}
      onSearchChange={onSearchChange}
    />
  );
}

function NoPreviewPanel() {
  return (
    <Panel>
      <PanelBody>
        <div className="flex flex-col items-center justify-center gap-3 py-14 text-center text-text-secondary">
          <GlobeIcon size={28} />
          <p className="text-sm">No preview environment for this pull request.</p>
        </div>
      </PanelBody>
    </Panel>
  );
}
