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
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { GearSixIcon } from "@phosphor-icons/react/GearSix";
import { HammerIcon } from "@phosphor-icons/react/Hammer";
import type { Icon } from "@phosphor-icons/react/lib";
import { LinkIcon } from "@phosphor-icons/react/Link";
import { TimerIcon } from "@phosphor-icons/react/Timer";
import { XCircleIcon } from "@phosphor-icons/react/XCircle";
import { PreviewLogsTabs, type PreviewLogSource } from "components/build-logs/preview-logs-tabs";
import { formatDuration } from "lib/format";
import { useRedeployPreviewApp } from "lib/query/deployments.queries";
import type { RouterOutputs } from "lib/trpc";
import { type ReactNode, useState } from "react";
import { SERVICE_ICON_BY_KEY, SERVICE_STATUS_META } from "../preview-status-meta";

type PreviewSummary = RouterOutputs["deployments"]["previewSummaryById"];
type PreviewService = PreviewSummary["services"][number];

/** URL-persisted view state for the explorer: the selected service and the chosen log focus. */
export type PreviewExplorerSearch = { service?: string; logs?: PreviewLogSource };

/**
 * The preview-environment explorer: the environment's services on the left, the selected service's
 * compact detail + logs in the center. Reused by the standalone preview-environment page and the PR
 * page's Preview tab - both resolve a `summary` (by environment id or by PR), render the environment-
 * level `EnvironmentSummaryStrip` above this component, and own the `{ service, logs }` URL state,
 * threaded in via `search` + `onSearchChange` so this component stays route-agnostic.
 */
export function PreviewEnvironmentExplorer({
  applicationId,
  environmentId,
  summary,
  search,
  onSearchChange,
}: {
  applicationId: string;
  environmentId: string;
  summary: PreviewSummary;
  search: PreviewExplorerSearch;
  onSearchChange: (partial: PreviewExplorerSearch) => void;
}) {
  const services = summary.services;
  const apps = services.filter(isAppService);
  const dependencies = services.filter((service) => !isAppService(service));
  const selectedService = services.find((service) => serviceKey(service) === search.service) ?? services[0];
  const onSelect = (service: PreviewService) => onSearchChange({ service: serviceKey(service) });

  return (
    <div className="flex min-h-0 flex-1 lg:flex-row">
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

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {selectedService != null && (
          <PreviewAppDetail service={selectedService} applicationId={applicationId} environmentId={environmentId} />
        )}
        {selectedService?.statusReason != null && (
          <span className="inline-flex items-center gap-1.5 border border-status-critical/30 bg-status-critical/10 px-2.5 py-1 font-mono text-xs text-status-critical">
            <XCircleIcon size={13} className="shrink-0" />
            {selectedService?.statusReason}
          </span>
        )}
        <PreviewLogsBody
          service={selectedService}
          repoFullName={summary.repoFullName}
          prNumber={summary.prNumber}
          logs={search.logs}
          onLogsChange={(next) => onSearchChange({ logs: next })}
        />
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

// Compact strip pinned directly above the logs, reflecting whichever service is selected in the
// rail: identity + status on one line, inline metadata on the next. Stays a fixed couple of lines
// regardless of viewport height, leaving the remaining space to the logs panel.
function PreviewAppDetail({
  service,
  applicationId,
  environmentId,
}: {
  service: PreviewService;
  applicationId: string;
  environmentId: string;
}) {
  const ServiceIcon = SERVICE_ICON_BY_KEY[service.iconKey] ?? GearSixIcon;
  const statusMeta = SERVICE_STATUS_META[service.status] ?? SERVICE_STATUS_META.unknown;

  return (
    <div className="flex shrink-0 flex-col gap-3 border border-border-dim bg-surface-base px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <ServiceIcon size={18} className="shrink-0 text-text-secondary" />
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm font-semibold text-text-primary">{service.name}</span>
          <span className="font-mono text-2xs uppercase tracking-wider text-text-secondary">{service.kind}</span>
        </div>
        <Badge variant={statusMeta.badge} className={cn("gap-1.5", statusMeta.className)}>
          <StatusDot status={statusMeta.dot} className="rounded-full" />
          {statusMeta.label}
        </Badge>
        {isAppService(service) && (
          <PreviewAppRedeployControl
            applicationId={applicationId}
            environmentId={environmentId}
            appName={service.name}
            disabled={service.status === "building"}
            className="ml-auto"
          />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-6">
        <InlineMeta label="URL" icon={LinkIcon}>
          {service.endpoint != null ? (
            <a
              href={service.endpoint}
              target="_blank"
              rel="noreferrer"
              className="inline-flex max-w-full items-center gap-1 transition-colors hover:text-text-primary hover:underline"
            >
              <ArrowSquareOutIcon size={11} className="shrink-0" />
              <span className="truncate">{service.endpoint}</span>
            </a>
          ) : (
            "-"
          )}
        </InlineMeta>
        <InlineMeta label="Build time" icon={TimerIcon}>
          {service.buildDurationMs != null ? formatDuration(service.buildDurationMs) : "-"}
        </InlineMeta>
      </div>
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
  className,
}: {
  applicationId: string;
  environmentId: string;
  appName: string;
  disabled: boolean;
  className?: string;
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
      <div className={cn("flex flex-wrap gap-2", className)}>
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

function InlineMeta({ label, icon: RowIcon, children }: { label: string; icon: Icon; children: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="flex shrink-0 items-center gap-1.5 font-mono text-2xs uppercase tracking-wider text-text-secondary">
        <RowIcon size={12} className="shrink-0" />
        {label}
      </span>
      <span className="min-w-0 truncate font-mono text-xs text-text-primary">{children}</span>
    </span>
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

/** Body skeleton mirroring the explorer's layout (services rail / detail+logs). */
export function PreviewEnvironmentExplorerSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 lg:flex-row">
      <Skeleton className="h-64 shrink-0 lg:w-72" />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Skeleton className="h-20 w-full shrink-0" />
        <Skeleton className="min-h-0 w-full flex-1" />
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
