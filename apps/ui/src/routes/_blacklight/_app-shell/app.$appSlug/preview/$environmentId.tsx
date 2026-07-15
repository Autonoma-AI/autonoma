import {
  Badge,
  BrailleSpinner,
  Button,
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Skeleton,
  StatusDot,
  cn,
} from "@autonoma/blacklight";
import type { PreviewRedeployAppMode } from "@autonoma/types";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/ArrowClockwise";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react/ArrowCounterClockwise";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { CalendarBlankIcon } from "@phosphor-icons/react/CalendarBlank";
import { ClockIcon } from "@phosphor-icons/react/Clock";
import { GearSixIcon } from "@phosphor-icons/react/GearSix";
import { GitBranchIcon } from "@phosphor-icons/react/GitBranch";
import { GlobeIcon } from "@phosphor-icons/react/Globe";
import { HammerIcon } from "@phosphor-icons/react/Hammer";
import type { Icon } from "@phosphor-icons/react/lib";
import { LinkIcon } from "@phosphor-icons/react/Link";
import { TimerIcon } from "@phosphor-icons/react/Timer";
import { QueryErrorResetBoundary } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { PreviewLogsTabs, type PreviewLogSource } from "components/build-logs/preview-logs-tabs";
import { formatDate, formatDuration, formatRelativeTime } from "lib/format";
import {
  ensurePreviewSummaryByIdData,
  useDeploymentHistory,
  usePreviewSummaryById,
  useRedeployPreviewApp,
} from "lib/query/deployments.queries";
import type { RouterOutputs } from "lib/trpc";
import { Component, type ReactNode, Suspense, useState } from "react";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";
import { useCurrentApplication } from "routes/_blacklight/_app-shell/-use-current-application";
import {
  PREVIEW_STATUS_META,
  SERVICE_ICON_BY_KEY,
  SERVICE_STATUS_META,
} from "../pull-requests/-components/preview-status-meta";
import { DeploymentRow } from "./-components/deployment-row";
import { TestUserCard, TestUserCardSkeleton, TestUserCardUnavailable } from "./-components/test-user-card";

type PreviewSummary = RouterOutputs["deployments"]["previewSummaryById"];
type PreviewService = PreviewSummary["services"][number];
type PreviewLatestBuild = PreviewSummary["latestBuild"];

// The deployment rail is docked to the right of the content area at a fixed width, full height, with
// its own left border. Desktop-only (the layout is a fixed three-column row); hidden below lg so it
// never squeezes the services + center columns on narrow screens. Shared by the rail, its skeleton,
// and its error state so all three occupy the same column footprint.
const DEPLOYMENT_RAIL_CLASS = "hidden shrink-0 flex-col border-l border-border-dim bg-surface-base lg:flex lg:w-80";

// Persisted in the URL so a refresh keeps the selected service and the chosen
// log focus (build vs app). `service` is the selected service's key.
type PreviewSearch = { service?: string; logs?: PreviewLogSource };

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/preview/$environmentId")({
  loader: async ({ context, params: { appSlug, environmentId } }) => {
    const app = context.applications.find((a) => a.slug === appSlug);
    if (app == null) throw notFound();
    // Only the summary is prefetched - it's the primary page content. The deployment history is a
    // secondary fetch owned entirely by the rail's own Suspense + error boundary, so a history
    // failure degrades the rail in place instead of failing the loader and taking down the page.
    await ensurePreviewSummaryByIdData(context.queryClient, app.id, environmentId);
  },
  validateSearch: (search: Record<string, unknown>): PreviewSearch => ({
    service: typeof search.service === "string" ? search.service : undefined,
    logs: search.logs === "build" || search.logs === "app" ? search.logs : undefined,
  }),
  component: PreviewEnvironmentPage,
});

function PreviewEnvironmentPage() {
  return (
    <div className="flex h-full flex-col gap-6">
      <Suspense fallback={<PreviewEnvironmentPageSkeleton />}>
        <PreviewEnvironmentContent />
      </Suspense>
    </div>
  );
}

function PreviewEnvironmentContent() {
  const { environmentId } = Route.useParams();
  const app = useCurrentApplication();
  const { data: summary } = usePreviewSummaryById(app.id, environmentId, { refetchWhileActive: true });
  const statusMeta = PREVIEW_STATUS_META[summary.status] ?? PREVIEW_STATUS_META.unknown;

  return (
    <>
      <PreviewHeader summary={summary} statusMeta={statusMeta} />
      {summary.status === "ready" ? (
        <Suspense fallback={<TestUserCardSkeleton />}>
          <TestUserCard applicationId={app.id} environmentId={environmentId} />
        </Suspense>
      ) : (
        <TestUserCardUnavailable status={summary.status} />
      )}
      <PreviewServicesExplorer summary={summary} />
    </>
  );
}

function PreviewHeader({
  summary,
  statusMeta,
}: {
  summary: PreviewSummary;
  statusMeta: (typeof PREVIEW_STATUS_META)[keyof typeof PREVIEW_STATUS_META];
}) {
  // Main-branch environments (PR #0) have no pull request, so identify them by branch instead.
  const identifier = summary.prNumber > 0 ? `#${summary.prNumber}` : summary.branch;

  return (
    <header className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2 text-text-secondary">
          <AppLink
            to="/app/$appSlug/preview-environments"
            aria-label="Back to preview environments"
            className="inline-flex size-5 shrink-0 items-center justify-center rounded text-text-secondary transition-colors hover:bg-surface-raised hover:text-text-primary"
          >
            <ArrowLeftIcon size={12} />
          </AppLink>
          <GlobeIcon size={14} />
          <span className="font-mono text-2xs uppercase tracking-widest">Preview environment</span>
          <span className="font-mono text-2xs">{identifier}</span>
        </div>
        <h1 className="text-2xl font-medium tracking-tight text-text-primary">Preview environment</h1>
        <div className="flex items-center gap-1.5 font-mono text-2xs text-text-secondary">
          <GitBranchIcon size={12} className="shrink-0" />
          <span className="truncate">{summary.branch}</span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Badge variant={statusMeta.badge} className={cn("gap-1.5", statusMeta.className)}>
          <StatusDot status={statusMeta.dot} className="rounded-full" />
          {statusMeta.label}
        </Badge>
        {/* The detail view is read-only; the build/services/env for these previews
            live in the app's Preview Environments settings, so link straight there. */}
        <AppLink
          to="/app/$appSlug/preview-config"
          className="ml-auto inline-flex items-center gap-1.5 border border-border-mid px-3 py-1.5 font-mono text-2xs text-text-secondary transition-colors hover:border-border-highlight hover:text-text-primary"
        >
          <GearSixIcon size={13} />
          Preview settings
        </AppLink>
      </div>

      {summary.error != null && <p className="text-sm text-status-critical">{summary.error}</p>}
    </header>
  );
}

// Three columns: the environment's services on the left, the selected service's detail + logs in
// the center, and the deployment rail docked on the right. The rail is bound to the environment
// (not the selected service), so it spans the full content-area height alongside the other two.
function PreviewServicesExplorer({ summary }: { summary: PreviewSummary }) {
  const services = summary.services;
  const apps = services.filter(isAppService);
  const dependencies = services.filter((service) => !isAppService(service));
  const navigate = Route.useNavigate();
  const { service: selectedKey } = Route.useSearch();
  const selectedService = services.find((service) => serviceKey(service) === selectedKey) ?? services[0];
  const onSelect = (service: PreviewService) =>
    void navigate({ search: (prev) => ({ ...prev, service: serviceKey(service) }), replace: true });
  // Only the current deploy's logs are retained (Loki keeps the latest attempt per repo+PR), so the
  // logs header is scoped to the currently-deployed SHA rather than any selected historical build.
  const currentSha = summary.lastDeployedSha ?? undefined;
  const environmentActive = summary.status === "building" || summary.phase === "deploy_requested";

  return (
    <div className="flex min-h-0 flex-1 gap-4 lg:flex-row">
      <aside className="flex shrink-0 flex-col lg:w-72">
        <div className="divide-y divide-border-dim border border-border-dim bg-surface-base lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
          {services.length === 0 ? (
            <div className="px-3 py-4 text-sm text-text-secondary">No services yet.</div>
          ) : (
            <>
              {apps.length > 0 && (
                <PreviewServiceGroup
                  label="Apps"
                  services={apps}
                  selectedService={selectedService}
                  onSelect={onSelect}
                />
              )}
              {dependencies.length > 0 && (
                <PreviewServiceGroup
                  label="Services"
                  services={dependencies}
                  selectedService={selectedService}
                  onSelect={onSelect}
                />
              )}
            </>
          )}
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
        {selectedService != null && <PreviewAppDetail service={selectedService} latestBuild={summary.latestBuild} />}
        <PreviewLogsSection
          service={selectedService}
          repoFullName={summary.repoFullName}
          prNumber={summary.prNumber}
          currentSha={currentSha}
        />
      </div>

      {/* The rail owns a secondary, informational fetch - isolate its failures in an error boundary
          so they degrade in place instead of taking down the services and logs via the router's
          default error UI. */}
      <QueryErrorResetBoundary>
        {({ reset }) => (
          <DeploymentRailErrorBoundary onRetry={reset}>
            <Suspense fallback={<DeploymentRailSkeleton />}>
              <DeploymentRail environmentActive={environmentActive} />
            </Suspense>
          </DeploymentRailErrorBoundary>
        )}
      </QueryErrorResetBoundary>
    </div>
  );
}

function PreviewServiceGroup({
  label,
  services,
  selectedService,
  onSelect,
}: {
  label: string;
  services: PreviewService[];
  selectedService: PreviewService | undefined;
  onSelect: (service: PreviewService) => void;
}) {
  return (
    <div>
      <div className="border-b border-border-dim px-3 py-2 font-mono text-3xs font-semibold uppercase tracking-wider text-text-secondary">
        {label} · {services.length}
      </div>
      {services.map((service) => (
        <PreviewServiceListItem
          key={serviceKey(service)}
          service={service}
          selected={selectedService != null && serviceKey(service) === serviceKey(selectedService)}
          onSelect={() => onSelect(service)}
        />
      ))}
    </div>
  );
}

function PreviewServiceListItem({
  service,
  selected,
  onSelect,
}: {
  service: PreviewService;
  selected: boolean;
  onSelect: () => void;
}) {
  const Icon = SERVICE_ICON_BY_KEY[service.iconKey] ?? GearSixIcon;
  const statusMeta = SERVICE_STATUS_META[service.status] ?? SERVICE_STATUS_META.unknown;

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "flex w-full items-center gap-2.5 border-b border-border-dim px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-surface-raised",
        selected && "bg-surface-raised",
      )}
    >
      <Icon size={15} className="shrink-0 text-text-secondary" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-text-primary">{service.name}</div>
        <div className="font-mono text-3xs uppercase tracking-wider text-text-secondary">{service.kind}</div>
      </div>
      <StatusDot status={statusMeta.dot} className="shrink-0 rounded-full" />
    </button>
  );
}

function PreviewAppDetail({ service, latestBuild }: { service: PreviewService; latestBuild: PreviewLatestBuild }) {
  const ServiceIcon = SERVICE_ICON_BY_KEY[service.iconKey] ?? GearSixIcon;
  const statusMeta = SERVICE_STATUS_META[service.status] ?? SERVICE_STATUS_META.unknown;
  // "Date" is when the latest environment build finished (fall back to its start). The duration
  // comes from the selected app's build outcome, since apps build independently.
  const buildDate = latestBuild?.finishedAt ?? latestBuild?.startedAt;

  return (
    <div className="shrink-0 border border-border-dim bg-surface-base">
      <div className="flex items-center gap-3 border-b border-border-dim px-4 py-3">
        <ServiceIcon size={18} className="shrink-0 text-text-secondary" />
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-text-primary">{service.name}</div>
          <div className="font-mono text-2xs uppercase tracking-wider text-text-secondary">{service.kind}</div>
        </div>
        <Badge variant={statusMeta.badge} className={cn("ml-auto gap-1.5", statusMeta.className)}>
          <StatusDot status={statusMeta.dot} className="rounded-full" />
          {statusMeta.label}
        </Badge>
      </div>

      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 px-4 py-4 sm:grid-cols-2">
        <DetailRow label="URL" icon={LinkIcon}>
          {service.endpoint != null ? (
            <a
              href={service.endpoint}
              target="_blank"
              rel="noreferrer"
              className="inline-flex max-w-full items-center gap-1 font-mono text-text-secondary transition-colors hover:text-text-primary hover:underline"
            >
              <ArrowSquareOutIcon size={11} className="shrink-0" />
              <span className="truncate">{service.endpoint}</span>
            </a>
          ) : (
            <span className="text-text-secondary">-</span>
          )}
        </DetailRow>
        <DetailRow label="Last built" icon={ClockIcon}>
          {service.lastBuiltAt != null ? formatRelativeTime(service.lastBuiltAt) : "-"}
        </DetailRow>
        <DetailRow label="Date" icon={CalendarBlankIcon}>
          {buildDate != null ? formatDate(buildDate) : "-"}
        </DetailRow>
        <DetailRow label="Build time" icon={TimerIcon}>
          {service.buildDurationMs != null ? formatDuration(service.buildDurationMs) : "-"}
        </DetailRow>
        {isAppService(service) && (
          <DetailRow label="Controls" icon={GearSixIcon}>
            <PreviewAppRedeployControl appName={service.name} disabled={service.status === "building"} />
          </DetailRow>
        )}
      </dl>

      {service.statusReason != null && (
        <div className="border-t border-border-dim px-4 py-3 text-xs text-status-critical">{service.statusReason}</div>
      )}
    </div>
  );
}

function PreviewAppRedeployControl({ appName, disabled }: { appName: string; disabled: boolean }) {
  const app = useCurrentApplication();
  const { environmentId } = Route.useParams();
  const redeploy = useRedeployPreviewApp(app.id, environmentId);
  const [selectedMode, setSelectedMode] = useState<PreviewRedeployAppMode>("rebuild");
  const [dialogOpen, setDialogOpen] = useState(false);
  const controlsDisabled = disabled || redeploy.isPending;
  const action = previewRedeployActionMeta(selectedMode, appName);

  function handleDialogOpenChange(open: boolean) {
    if (redeploy.isPending) return;
    setDialogOpen(open);
  }

  function openConfirmation(mode: PreviewRedeployAppMode) {
    setSelectedMode(mode);
    setDialogOpen(true);
  }

  function confirmRedeploy() {
    redeploy.mutate(
      { applicationId: app.id, environmentId, app: appName, mode: selectedMode },
      { onSuccess: () => setDialogOpen(false) },
    );
  }

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="xs"
          className="gap-1.5"
          disabled={controlsDisabled}
          onClick={() => openConfirmation("rebuild")}
        >
          <HammerIcon size={12} />
          Rebuild
        </Button>
        <Button
          variant="outline"
          size="xs"
          className="gap-1.5"
          disabled={controlsDisabled}
          onClick={() => openConfirmation("restart")}
        >
          <ArrowClockwiseIcon size={12} />
          Restart
        </Button>
      </div>

      <Dialog open={dialogOpen} onOpenChange={handleDialogOpenChange}>
        <DialogBackdrop />
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{action.title}</DialogTitle>
            <DialogDescription>{action.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={redeploy.isPending} />}>Cancel</DialogClose>
            <Button onClick={confirmRedeploy} disabled={redeploy.isPending} className="gap-1.5">
              {redeploy.isPending ? <BrailleSpinner animation="braille" size="sm" /> : <action.Icon size={14} />}
              {redeploy.isPending ? action.pendingLabel : action.confirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function previewRedeployActionMeta(mode: PreviewRedeployAppMode, appName: string) {
  if (mode === "rebuild") {
    return {
      title: `Rebuild ${appName}?`,
      description: `Builds a new image for ${appName} from this environment's current commit, then redeploys only this app. Other apps keep running.`,
      confirmLabel: "Confirm rebuild",
      pendingLabel: "Rebuilding...",
      Icon: HammerIcon,
    };
  }

  return {
    title: `Restart ${appName}?`,
    description: `Restarts ${appName} with its existing image. Use this after changing runtime secrets or environment variables. No source build runs, and other apps keep running.`,
    confirmLabel: "Confirm restart",
    pendingLabel: "Restarting...",
    Icon: ArrowClockwiseIcon,
  };
}

function DetailRow({ label, icon: RowIcon, children }: { label: string; icon: Icon; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="flex items-center gap-1.5 font-mono text-2xs uppercase tracking-wider text-text-secondary">
        <RowIcon size={12} className="shrink-0" />
        {label}
      </dt>
      <dd className="min-w-0 text-sm text-text-primary">{children}</dd>
    </div>
  );
}

function PreviewLogsSection({
  service,
  repoFullName,
  prNumber,
  currentSha,
}: {
  service: PreviewService | undefined;
  repoFullName: string;
  prNumber: number;
  currentSha: string | undefined;
}) {
  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <h2 className="text-sm font-semibold text-text-primary">Logs</h2>
        {service != null && currentSha != null && (
          <span className="truncate font-mono text-2xs text-text-secondary">
            {service.name} @ {currentSha.slice(0, 7)}
          </span>
        )}
      </div>
      <PreviewLogsBody service={service} repoFullName={repoFullName} prNumber={prNumber} />
    </section>
  );
}

function PreviewLogsBody({
  service,
  repoFullName,
  prNumber,
}: {
  service: PreviewService | undefined;
  repoFullName: string;
  prNumber: number;
}) {
  const navigate = Route.useNavigate();
  const { logs } = Route.useSearch();

  // Apps carry both build and runtime logs; recipe services (postgres, redis, ...) run as in-cluster
  // pods with runtime output but are not built from the PR; only external addons have no logs at all.
  if (service != null && service.logAvailability === "none") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center border border-border-dim bg-surface-base px-4 py-5 text-center text-sm text-text-secondary">
        No logs for this service.
      </div>
    );
  }

  const [owner = "", repo = ""] = repoFullName.split("/");
  return (
    <PreviewLogsTabs
      owner={owner}
      repo={repo}
      pr={prNumber}
      app={service?.name}
      appBuilding={service?.status === "building"}
      runtimeOnly={service?.logAvailability === "runtime_only"}
      source={logs}
      onSourceChange={(next) => void navigate({ search: (prev) => ({ ...prev, logs: next }), replace: true })}
      fill
      className="border border-border-dim bg-surface-base p-3"
    />
  );
}

// The deployment rail: docked right, full content-area height, bound to the environment. Lists the
// environment's deploys newest-first; the current deploy is highlighted, past deploys are display-
// only (their per-commit logs aren't retained, so there's nothing to scope to).
function DeploymentRail({ environmentActive }: { environmentActive: boolean }) {
  const { environmentId } = Route.useParams();
  const app = useCurrentApplication();
  const { data: deployments } = useDeploymentHistory(app.id, environmentId, { pollWhileActive: environmentActive });

  return (
    <aside className={DEPLOYMENT_RAIL_CLASS}>
      <div className="flex shrink-0 items-center gap-2 border-b border-border-dim px-4 py-3">
        <span className="size-2 shrink-0 rounded-full bg-primary" />
        <h2 className="text-sm font-semibold text-text-primary">Deployments</h2>
        <span className="ml-auto font-mono text-2xs tabular-nums text-text-secondary">{deployments.length}</span>
      </div>
      <div className="min-h-0 flex-1 divide-y divide-border-dim overflow-y-auto">
        {deployments.length === 0 ? (
          <div className="px-4 py-3 text-sm text-text-secondary">No deployments yet.</div>
        ) : (
          deployments.map((deployment) => <DeploymentRow key={deployment.id} deployment={deployment} />)
        )}
      </div>
    </aside>
  );
}

function DeploymentRailSkeleton() {
  return (
    <aside className={DEPLOYMENT_RAIL_CLASS}>
      <div className="flex shrink-0 items-center gap-2 border-b border-border-dim px-4 py-3">
        <Skeleton className="size-2 rounded-full" />
        <Skeleton className="h-5 w-28" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    </aside>
  );
}

// Isolates a failed `deployments.history` fetch (thrown by useSuspenseQuery) to the rail. Retry
// clears the local error and resets the query cache (via onRetry) so the child refetches.
class DeploymentRailErrorBoundary extends Component<
  { children: ReactNode; onRetry: () => void },
  { hasError: boolean }
> {
  override state: { hasError: boolean } = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  override render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <aside className={DEPLOYMENT_RAIL_CLASS}>
        <div className="flex shrink-0 items-center gap-2 border-b border-border-dim px-4 py-3">
          <span className="size-2 shrink-0 rounded-full bg-primary" />
          <h2 className="text-sm font-semibold text-text-primary">Deployments</h2>
        </div>
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-4 py-3 text-center text-sm text-text-secondary">
          <span>Couldn't load deployments.</span>
          <Button
            variant="outline"
            size="xs"
            className="gap-1.5"
            onClick={() => {
              this.setState({ hasError: false });
              this.props.onRetry();
            }}
          >
            <ArrowCounterClockwiseIcon size={12} />
            Retry
          </Button>
        </div>
      </aside>
    );
  }
}

function serviceKey(service: PreviewService): string {
  return `${service.kind}-${service.name}`;
}

// Apps (web/api/worker) are deployed from the PR branch and carry per-app build/runtime logs;
// everything else (databases, caches, addons) is grouped under "Services".
function isAppService(service: PreviewService): boolean {
  return service.branchSource === "matched_pr_branch";
}

function PreviewEnvironmentPageSkeleton() {
  return (
    <>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-44" />
        <Skeleton className="h-8 w-60" />
        <div className="flex gap-3">
          <Skeleton className="h-6 w-24" />
          <Skeleton className="h-7 w-32" />
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
        <Skeleton className="h-64 shrink-0 lg:w-72" />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
          <Skeleton className="h-44 w-full shrink-0" />
          <Skeleton className="min-h-0 w-full flex-1" />
        </div>
        <Skeleton className="hidden shrink-0 lg:block lg:w-80" />
      </div>
    </>
  );
}
