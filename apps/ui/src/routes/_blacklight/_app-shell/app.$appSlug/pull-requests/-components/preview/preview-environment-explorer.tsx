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
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { CalendarBlankIcon } from "@phosphor-icons/react/CalendarBlank";
import { ClockIcon } from "@phosphor-icons/react/Clock";
import { GearSixIcon } from "@phosphor-icons/react/GearSix";
import { HammerIcon } from "@phosphor-icons/react/Hammer";
import type { Icon } from "@phosphor-icons/react/lib";
import { LinkIcon } from "@phosphor-icons/react/Link";
import { TimerIcon } from "@phosphor-icons/react/Timer";
import { QueryErrorResetBoundary } from "@tanstack/react-query";
import { PreviewLogsTabs, type PreviewLogSource } from "components/build-logs/preview-logs-tabs";
import { formatDate, formatDuration, formatRelativeTime } from "lib/format";
import { useDeploymentHistory, useRedeployPreviewApp } from "lib/query/deployments.queries";
import type { RouterOutputs } from "lib/trpc";
import { Component, type ReactNode, Suspense, useState } from "react";
import { SERVICE_ICON_BY_KEY, SERVICE_STATUS_META } from "../preview-status-meta";
import { DeploymentRow } from "./deployment-row";
import { TestUserCard, TestUserCardSkeleton, TestUserCardUnavailable } from "./test-user-card";

type PreviewSummary = RouterOutputs["deployments"]["previewSummaryById"];
type PreviewService = PreviewSummary["services"][number];
type PreviewLatestBuild = PreviewSummary["latestBuild"];

/** URL-persisted view state for the explorer: the selected service and the chosen log focus. */
export type PreviewExplorerSearch = { service?: string; logs?: PreviewLogSource };

// The deployment rail is docked to the right of the content area at a fixed width, full height, with
// its own left border. Desktop-only (the layout is a fixed three-column row); hidden below lg so it
// never squeezes the services + center columns on narrow screens. Shared by the rail, its skeleton,
// and its error state so all three occupy the same column footprint.
const DEPLOYMENT_RAIL_CLASS = "hidden shrink-0 flex-col border-l border-border-dim bg-surface-base lg:flex lg:w-80";

/**
 * The preview-environment explorer: the environment's services on the left, the selected service's
 * detail + logs in the center, and the deployment-history rail docked on the right. Reused by the
 * standalone preview-environment page and the PR page's Preview tab - both resolve a `summary` (by
 * environment id or by PR) and own the `{ service, logs }` URL state, threaded in via `search` +
 * `onSearchChange` so this component stays route-agnostic.
 */
export function PreviewEnvironmentExplorer({
  applicationId,
  environmentId,
  summary,
  search,
  onSearchChange,
  showEnvironmentSummary = true,
}: {
  applicationId: string;
  environmentId: string;
  summary: PreviewSummary;
  search: PreviewExplorerSearch;
  onSearchChange: (partial: PreviewExplorerSearch) => void;
  /**
   * Set to false when an ancestor already renders the environment-level summary (the redesigned
   * Preview tab's `EnvironmentSummaryStrip`), so this component only renders the rail + selected-
   * service detail + logs. Defaults to true: the standalone/main-branch usage owns the full
   * composition, unchanged.
   */
  showEnvironmentSummary?: boolean;
}) {
  const services = summary.services;
  const apps = services.filter(isAppService);
  const dependencies = services.filter((service) => !isAppService(service));
  const selectedService = services.find((service) => serviceKey(service) === search.service) ?? services[0];
  const onSelect = (service: PreviewService) => onSearchChange({ service: serviceKey(service) });
  // Only the current deploy's logs are retained (Loki keeps the latest attempt per repo+PR), so the
  // logs header is scoped to the currently-deployed SHA rather than any selected historical build.
  const currentSha = summary.lastDeployedSha ?? undefined;
  const environmentActive = summary.status === "building" || summary.phase === "deploy_requested";

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {showEnvironmentSummary &&
        (summary.status === "ready" ? (
          <Suspense fallback={<TestUserCardSkeleton />}>
            <TestUserCard applicationId={applicationId} environmentId={environmentId} />
          </Suspense>
        ) : (
          <TestUserCardUnavailable status={summary.status} />
        ))}
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
          {selectedService != null && (
            <PreviewAppDetail
              service={selectedService}
              latestBuild={summary.latestBuild}
              applicationId={applicationId}
              environmentId={environmentId}
            />
          )}
          <PreviewLogsSection
            service={selectedService}
            repoFullName={summary.repoFullName}
            prNumber={summary.prNumber}
            currentSha={currentSha}
            logs={search.logs}
            onLogsChange={(next) => onSearchChange({ logs: next })}
          />
        </div>

        {/* The rail owns a secondary, informational fetch - isolate its failures in an error boundary
                so they degrade in place instead of taking down the services and logs via the router's
                default error UI. */}
        {showEnvironmentSummary && (
          <QueryErrorResetBoundary>
            {({ reset }) => (
              <DeploymentRailErrorBoundary onRetry={reset}>
                <Suspense fallback={<DeploymentRailSkeleton />}>
                  <DeploymentRail
                    applicationId={applicationId}
                    environmentId={environmentId}
                    environmentActive={environmentActive}
                  />
                </Suspense>
              </DeploymentRailErrorBoundary>
            )}
          </QueryErrorResetBoundary>
        )}
      </div>
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
  const ServiceIcon = SERVICE_ICON_BY_KEY[service.iconKey] ?? GearSixIcon;
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
      <ServiceIcon size={15} className="shrink-0 text-text-secondary" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-text-primary">{service.name}</div>
        <div className="font-mono text-3xs uppercase tracking-wider text-text-secondary">{service.kind}</div>
      </div>
      <StatusDot status={statusMeta.dot} className="shrink-0 rounded-full" />
    </button>
  );
}

function PreviewAppDetail({
  service,
  latestBuild,
  applicationId,
  environmentId,
}: {
  service: PreviewService;
  latestBuild: PreviewLatestBuild;
  applicationId: string;
  environmentId: string;
}) {
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
            <PreviewAppRedeployControl
              applicationId={applicationId}
              environmentId={environmentId}
              appName={service.name}
              disabled={service.status === "building"}
            />
          </DetailRow>
        )}
      </dl>

      {service.statusReason != null && (
        <div className="border-t border-border-dim px-4 py-3 text-xs text-status-critical">{service.statusReason}</div>
      )}
    </div>
  );
}

// Per-app redeploy controls (rebuild / restart). Route-agnostic: takes application + environment ids
// as props rather than reading them from a route, so it works under any of the routes that embed the
// explorer.
function PreviewAppRedeployControl({
  applicationId,
  environmentId,
  appName,
  disabled,
}: {
  applicationId: string;
  environmentId: string;
  appName: string;
  disabled: boolean;
}) {
  const redeploy = useRedeployPreviewApp(applicationId, environmentId);
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
      { applicationId, environmentId, app: appName, mode: selectedMode },
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
  logs,
  onLogsChange,
}: {
  service: PreviewService | undefined;
  repoFullName: string;
  prNumber: number;
  currentSha: string | undefined;
  logs: PreviewLogSource | undefined;
  onLogsChange: (next: PreviewLogSource) => void;
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
      <PreviewLogsBody
        service={service}
        repoFullName={repoFullName}
        prNumber={prNumber}
        logs={logs}
        onLogsChange={onLogsChange}
      />
    </section>
  );
}

function PreviewLogsBody({
  service,
  repoFullName,
  prNumber,
  logs,
  onLogsChange,
}: {
  service: PreviewService | undefined;
  repoFullName: string;
  prNumber: number;
  logs: PreviewLogSource | undefined;
  onLogsChange: (next: PreviewLogSource) => void;
}) {
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
      onSourceChange={onLogsChange}
      fill
      toolbar
    />
  );
}

// The deployment rail: docked right, full content-area height, bound to the environment. Lists the
// environment's deploys newest-first; the current deploy is highlighted, past deploys are display-
// only (their per-commit logs aren't retained, so there's nothing to scope to).
function DeploymentRail({
  applicationId,
  environmentId,
  environmentActive,
}: {
  applicationId: string;
  environmentId: string;
  environmentActive: boolean;
}) {
  const { data: deployments } = useDeploymentHistory(applicationId, environmentId, {
    pollWhileActive: environmentActive,
  });

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

/** Body skeleton mirroring the explorer's three-column layout (services / detail+logs / rail). */
export function PreviewEnvironmentExplorerSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <TestUserCardSkeleton />
      <div className="flex min-h-0 flex-1 gap-4 lg:flex-row">
        <Skeleton className="h-64 shrink-0 lg:w-72" />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
          <Skeleton className="h-44 w-full shrink-0" />
          <Skeleton className="min-h-0 w-full flex-1" />
        </div>
        <Skeleton className="hidden shrink-0 lg:block lg:w-80" />
      </div>
    </div>
  );
}

function serviceKey(service: PreviewService): string {
  return `${service.kind}-${service.name}`;
}

// Apps (web/api/worker) are deployed from the PR branch and carry per-app build/runtime logs;
// everything else (databases, caches, addons) is grouped under "Services".
function isAppService(service: PreviewService): boolean {
  return service.branchSource === "matched_pr_branch";
}
