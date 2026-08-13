import {
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
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { GearSixIcon } from "@phosphor-icons/react/GearSix";
import { HammerIcon } from "@phosphor-icons/react/Hammer";
import type { Icon } from "@phosphor-icons/react/lib";
import { LinkIcon } from "@phosphor-icons/react/Link";
import { TimerIcon } from "@phosphor-icons/react/Timer";
import { XCircleIcon } from "@phosphor-icons/react/XCircle";
import { PreviewLogsTabs, type PreviewLogSource } from "components/build-logs/preview-logs-tabs";
import { PreviewCrashedEmptyState } from "components/preview-crashed-empty-state";
import { PreviewIdleEmptyState } from "components/preview-idle-empty-state";
import { PreviewLink } from "components/preview-link";
import { PREVIEW_STATUS_HELP, PreviewStatusBadge } from "components/preview-status-badge";
import { formatDuration } from "lib/format";
import { useRedeployPreviewApp } from "lib/query/deployments.queries";
import { type PreviewLivenessState, useEnvironmentLiveness } from "lib/query/preview-access.queries";
import type { RouterOutputs } from "lib/trpc";
import { type ReactNode, Suspense, useState } from "react";
import { SERVICE_ICON_BY_KEY, SERVICE_STATUS_META } from "../preview-status-meta";
import { TestUserButton, TestUserButtonSkeleton, TestUserButtonUnavailable } from "./test-user-button";

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
  const livenessState = useEnvironmentLiveness(services);

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
          <PreviewAppDetail
            service={selectedService}
            applicationId={applicationId}
            environmentId={environmentId}
            summaryStatus={summary.status}
          />
        )}
        {selectedService?.statusReason != null && (
          <ServiceFailureNote reason={selectedService.statusReason} explanation={selectedService.statusExplanation} />
        )}
        <PreviewLogsBody
          service={selectedService}
          repoFullName={summary.repoFullName}
          prNumber={summary.prNumber}
          livenessState={livenessState}
          openPreview={summary.actions.openPreview}
          logs={search.logs}
          onLogsChange={(next) => onSearchChange({ logs: next })}
        />
      </div>
    </div>
  );
}

/** Where the cause lives, as the words on the tab the reader has to click. */
const EVIDENCE_SOURCE_HINT: Record<NonNullable<PreviewService["statusExplanation"]>["lookIn"], string> = {
  app_logs: "The reason is in App logs below, not Build logs.",
  build_logs: "The reason is in Build logs below.",
  config: "Nothing ran, so there are no app logs - check this app's configuration and secrets.",
};

/**
 * Why the selected service is not up.
 *
 * The platform's own message is a Kubernetes rollout error carrying pod hashes and a namespace UUID, and
 * it used to be the entire content of this strip - which is how somebody debugging their first preview
 * was shown `container api is in CrashLoopBackOff: back-off 10s restarting failed container=api
 * pod=api-54d89594cc-nmjjn_preview-…`. It is still here, because it is what an engineer pastes into a
 * search or hands to support; it is just no longer the headline, and it no longer stands alone.
 *
 * With no explanation (a message nothing has classified yet) this renders exactly what it always did,
 * rather than guessing.
 */
function ServiceFailureNote({
  reason,
  explanation,
}: {
  reason: string;
  explanation: PreviewService["statusExplanation"];
}) {
  const [detailOpen, setDetailOpen] = useState(false);

  if (explanation == null) {
    return (
      <span className="inline-flex items-center gap-1.5 border border-status-critical/30 bg-status-critical/10 px-2.5 py-1 font-mono text-xs text-status-critical">
        <XCircleIcon size={13} className="shrink-0" />
        {reason}
      </span>
    );
  }

  return (
    <div className="flex flex-col gap-2 border border-status-critical/30 bg-status-critical/10 px-3 py-2.5">
      <div className="flex items-start gap-2">
        <XCircleIcon size={14} className="mt-0.5 shrink-0 text-status-critical" />
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-sm font-medium text-text-primary">{explanation.title}</p>
          <p className="text-2xs leading-relaxed text-text-secondary">{explanation.explanation}</p>
          <p className="text-2xs font-medium text-text-primary">{EVIDENCE_SOURCE_HINT[explanation.lookIn]}</p>
        </div>
      </div>
      <button
        type="button"
        onClick={() => setDetailOpen((open) => !open)}
        aria-expanded={detailOpen}
        className="flex items-center gap-1 self-start font-mono text-3xs uppercase tracking-widest text-text-secondary transition-colors hover:text-text-primary"
      >
        <CaretDownIcon size={11} className={cn("transition-transform", detailOpen && "rotate-180")} />
        {detailOpen ? "Hide technical detail" : "Show technical detail"}
      </button>
      {detailOpen && (
        <p className="break-all border-t border-status-critical/20 pt-2 font-mono text-3xs text-text-secondary">
          {explanation.technicalDetail}
        </p>
      )}
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
  summaryStatus,
}: {
  service: PreviewService;
  applicationId: string;
  environmentId: string;
  summaryStatus: string;
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
        {/* "Ready" is redundant with the environment's runtime badge (Live/Idle) in
            the strip above; only show a per-service status when it's not ready. */}
        {service.status !== "ready" && (
          <PreviewStatusBadge
            label={statusMeta.label}
            variant={statusMeta.badge}
            help={PREVIEW_STATUS_HELP[statusMeta.label]}
            className={statusMeta.className}
          />
        )}
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
            <PreviewLink
              url={service.endpoint}
              className="inline-flex max-w-full items-center gap-1 transition-colors hover:text-text-primary hover:underline"
            >
              <ArrowSquareOutIcon size={11} className="shrink-0" />
              <span className="truncate">{service.endpoint}</span>
            </PreviewLink>
          ) : (
            "-"
          )}
        </InlineMeta>
        {/* Sits with the URL rather than in the environment strip: the test user only means
            anything paired with the address you open, even though it is environment-scoped.
            Only the live button needs an endpoint - an app's endpoint is null exactly when
            there is no running instance, which is when the disabled button's reason matters. */}
        {isAppService(service) &&
          (summaryStatus === "ready" && service.endpoint != null ? (
            <Suspense fallback={<TestUserButtonSkeleton />}>
              <TestUserButton applicationId={applicationId} environmentId={environmentId} />
            </Suspense>
          ) : (
            <TestUserButtonUnavailable status={summaryStatus} />
          ))}
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
  livenessState,
  openPreview,
  logs,
  onLogsChange,
}: {
  service: PreviewService | undefined;
  repoFullName: string;
  prNumber: number;
  livenessState: PreviewLivenessState;
  openPreview: PreviewSummary["actions"]["openPreview"];
  logs: PreviewLogSource | undefined;
  onLogsChange: (next: PreviewLogSource) => void;
}) {
  // Apps carry both build and runtime logs; recipe services (postgres, redis, ...) run as in-cluster
  // pods with runtime output but are not built from the PR.
  if (service != null && service.logAvailability === "none") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center border border-border-dim bg-surface-base px-4 py-5 text-center text-sm text-text-secondary">
        No logs for this service.
      </div>
    );
  }

  const [owner = "", repo = ""] = repoFullName.split("/");
  // Two ways an app stream stays silent forever, and the spinner is wrong for both. A preview
  // scaled to zero produces no runtime output, so the tab says so and offers to wake it. An app
  // that died on startup may never have logged at all - and the failure note above has just sent
  // the reader here, so an indefinite spinner reads as "still loading" at the worst moment.
  // Either way this only replaces the spinner: any output the app did produce still wins.
  const wakeUrl = openPreview.enabled && openPreview.href != null ? openPreview.href : undefined;
  const appEmptyState = resolveAppEmptyState(service, livenessState, wakeUrl);

  return (
    <PreviewLogsTabs
      owner={owner}
      repo={repo}
      pr={prNumber}
      app={service?.name}
      appBuilding={service?.status === "building"}
      appEmptyState={appEmptyState}
      runtimeOnly={service?.logAvailability === "runtime_only"}
      source={logs}
      onSourceChange={onLogsChange}
      fill
      toolbar
    />
  );
}

/**
 * Which empty state the App logs panel should show in place of its "waiting for output" spinner,
 * or undefined to leave the spinner alone.
 *
 * Keyed on the classified explanation rather than on `status === "failed"`, so it speaks only where
 * it knows what happened. A build failure carries no explanation (the build's own output is the
 * story, one tab over) and keeps the spinner, rather than being told its app "exited" when no
 * container ever started.
 *
 * Order matters: a failed app is answered first. A crashlooping workload can also read as `asleep`
 * once the cluster stops counting it, and "Preview is idle - start it" would be actively misleading
 * for something that is failing to start on its own.
 */
function resolveAppEmptyState(
  service: PreviewService | undefined,
  livenessState: PreviewLivenessState,
  wakeUrl: string | undefined,
) {
  if (service?.statusExplanation != null) {
    return <PreviewCrashedEmptyState appName={service.name} lookIn={service.statusExplanation.lookIn} />;
  }
  if (livenessState === "asleep") return <PreviewIdleEmptyState url={wakeUrl} />;
  return undefined;
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
// everything else (databases, caches) is grouped under "Services".
function isAppService(service: PreviewService): boolean {
  return service.branchSource === "matched_pr_branch";
}
