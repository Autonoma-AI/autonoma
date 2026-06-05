import { Badge, Panel, PanelBody, StatusDot, cn } from "@autonoma/blacklight";
import { BracketsCurlyIcon } from "@phosphor-icons/react/BracketsCurly";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CloudIcon } from "@phosphor-icons/react/Cloud";
import { CubeIcon } from "@phosphor-icons/react/Cube";
import { DatabaseIcon } from "@phosphor-icons/react/Database";
import { GearSixIcon } from "@phosphor-icons/react/GearSix";
import { GlobeIcon } from "@phosphor-icons/react/Globe";
import { NetworkIcon } from "@phosphor-icons/react/Network";
import { PackageIcon } from "@phosphor-icons/react/Package";
import { StackIcon } from "@phosphor-icons/react/Stack";
import { TreeStructureIcon } from "@phosphor-icons/react/TreeStructure";
import { WarningDiamondIcon } from "@phosphor-icons/react/WarningDiamond";
import { formatDate } from "lib/format";
import { usePreviewEnvironmentSummary } from "lib/query/deployments.queries";
import type { RouterOutputs } from "lib/trpc";
import { type ReactNode, useState } from "react";

type PreviewSummary = RouterOutputs["deployments"]["previewSummaryByPr"];
type PreviewService = PreviewSummary["services"][number];

export function PreviewEnvironmentSection({ applicationId, prNumber }: { applicationId: string; prNumber: number }) {
  const [open, setOpen] = useState(false);
  const { data: summary } = usePreviewEnvironmentSummary(applicationId, prNumber);
  const statusMeta = PREVIEW_STATUS_META[summary.status] ?? PREVIEW_STATUS_META.unknown;
  const primaryHost = summary.primaryUrl != null ? hostname(summary.primaryUrl) : null;
  const previewHref =
    summary.actions.openPreview.enabled && summary.actions.openPreview.href != null
      ? summary.actions.openPreview.href
      : undefined;
  const hasServiceDetails = summary.serviceCount > 0;

  return (
    <Panel>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-4 border-b border-border-dim px-5 py-4 text-left transition-colors hover:bg-surface-raised"
      >
        <CaretDownIcon
          size={14}
          className={cn("shrink-0 text-text-tertiary transition-transform", open ? "rotate-0" : "-rotate-90")}
        />
        <StatusDot status={statusMeta.dot} className="rounded-full" />
        <span className="font-mono text-2xs font-bold uppercase tracking-wider text-primary-ink">
          Preview Environment
        </span>
        {hasServiceDetails && (
          <span className="font-mono text-xs text-text-tertiary">{summary.serviceCount} services</span>
        )}
        {summary.readyServiceCount > 0 && <CountPill dot="success" value={summary.readyServiceCount} label="ready" />}
        {summary.degradedServiceCount > 0 && (
          <CountPill dot="warn" value={summary.degradedServiceCount} label="degraded" />
        )}
        {summary.failedServiceCount > 0 && (
          <CountPill dot="critical" value={summary.failedServiceCount} label="failed" />
        )}

        <div className="ml-auto flex min-w-0 items-center gap-3">
          {primaryHost != null && (
            <PreviewUrl href={previewHref} className="truncate font-mono text-xs text-text-primary">
              {primaryHost}
            </PreviewUrl>
          )}
        </div>
      </button>

      {open && (
        <PanelBody className="flex flex-col gap-5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <Badge variant={statusMeta.badge} className={statusMeta.className}>
                {statusMeta.label}
              </Badge>
              {summary.primaryUrl != null && (
                <PreviewUrl href={previewHref} className="truncate font-mono text-xs text-text-secondary">
                  {summary.primaryUrl}
                </PreviewUrl>
              )}
              <span className="ml-auto font-mono text-2xs uppercase tracking-wider text-text-tertiary">
                Auto-redeploy on push
              </span>
            </div>

            <PreviewMessage summary={summary} />

            <div className="mt-5 divide-y divide-border-dim border-y border-border-dim">
              {summary.services.length === 0 ? (
                <div className="px-4 py-5 text-sm text-text-secondary">Service details unavailable.</div>
              ) : (
                summary.services.map((service) => (
                  <PreviewServiceRow key={`${service.kind}-${service.name}`} service={service} />
                ))
              )}
            </div>
          </div>
        </PanelBody>
      )}
    </Panel>
  );
}

function CountPill({ dot, value, label }: { dot: "success" | "warn" | "critical"; value: number; label: string }) {
  return (
    <span className="hidden items-center gap-2 font-mono text-xs text-text-tertiary sm:inline-flex">
      <StatusDot status={dot} />
      {value} {label}
    </span>
  );
}

function PreviewUrl({
  href,
  className,
  children,
}: {
  href: string | undefined;
  className: string;
  children: ReactNode;
}) {
  if (href == null) return <span className={className}>{children}</span>;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => event.stopPropagation()}
      className={cn(className, "transition-colors hover:text-text-primary hover:underline")}
    >
      {children}
    </a>
  );
}

function PreviewMessage({ summary }: { summary: PreviewSummary }) {
  const copy =
    summary.status === "missing"
      ? "Preview environment is not configured for this pull request."
      : summary.status === "building"
        ? "Autonoma is preparing this PR preview."
        : summary.status === "degraded"
          ? "Preview is available, but at least one service needs attention."
          : summary.status === "failed"
            ? "Preview setup failed before a usable environment became available."
            : summary.status === "stale"
              ? "Preview is for an older commit. Autonoma is redeploying or waiting for redeploy."
              : summary.status === "stopped"
                ? "This preview environment has been stopped."
                : summary.status === "ready"
                  ? "Preview is ready for review."
                  : "Preview status is currently unknown.";

  return (
    <div className="mt-4 grid grid-cols-1 gap-3 text-sm text-text-secondary md:grid-cols-3">
      <p className="md:col-span-2">{summary.error ?? copy}</p>
      <div className="space-y-1 font-mono text-2xs uppercase tracking-wider text-text-tertiary md:text-right">
        {summary.deployedAt != null && <div>Deployed {formatDate(summary.deployedAt)}</div>}
        {summary.lastDeployedSha != null && <div>SHA {summary.lastDeployedSha.slice(0, 7)}</div>}
        {summary.phase != null && <div>{summary.phase}</div>}
      </div>
    </div>
  );
}

function PreviewServiceRow({ service }: { service: PreviewService }) {
  const statusMeta = SERVICE_STATUS_META[service.status] ?? SERVICE_STATUS_META.unknown;
  const Icon = SERVICE_ICON_BY_KEY[service.iconKey] ?? GearSixIcon;

  return (
    <div className="grid gap-3 px-4 py-3 md:grid-cols-[minmax(140px,220px)_minmax(0,1fr)_auto]">
      <div className="flex min-w-0 items-center gap-3">
        <Icon size={15} className="shrink-0 text-text-tertiary" />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-text-primary">{service.name}</div>
          <div className="font-mono text-2xs uppercase tracking-wider text-text-tertiary">{service.kind}</div>
        </div>
      </div>

      <div className="min-w-0 text-xs text-text-secondary">
        <div className="truncate font-mono">{service.endpoint ?? service.branchHint ?? "No endpoint available"}</div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-text-tertiary">
          {service.branch != null && <span>branch {service.branch}</span>}
          {service.port != null && <span>port {service.port}</span>}
          {service.imageTag != null && <span>image {service.imageTag}</span>}
        </div>
        {service.statusReason != null && (
          <div className="mt-1 truncate text-status-critical">{service.statusReason}</div>
        )}
      </div>

      <Badge variant={statusMeta.badge} className={cn("justify-self-start md:justify-self-end", statusMeta.className)}>
        {statusMeta.label}
      </Badge>
    </div>
  );
}

function hostname(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const PREVIEW_STATUS_META = {
  ready: { label: "Ready", dot: "success", badge: "success", className: "" },
  building: { label: "Building", dot: "warn", badge: "status-running", className: "" },
  degraded: { label: "Degraded", dot: "warn", badge: "warn", className: "" },
  failed: { label: "Failed", dot: "critical", badge: "status-failed", className: "" },
  stopped: { label: "Stopped", dot: "neutral", badge: "outline", className: "text-text-tertiary" },
  missing: { label: "Missing", dot: "neutral", badge: "outline", className: "text-text-tertiary" },
  stale: { label: "Stale", dot: "warn", badge: "warn", className: "" },
  unknown: { label: "Unknown", dot: "neutral", badge: "outline", className: "text-text-tertiary" },
} as const;

const SERVICE_STATUS_META = {
  ready: { label: "Ready", badge: "success", className: "" },
  building: { label: "Building", badge: "status-running", className: "" },
  failed: { label: "Failed", badge: "status-failed", className: "" },
  fallback: { label: "Fallback", badge: "warn", className: "" },
  stopped: { label: "Stopped", badge: "outline", className: "text-text-tertiary" },
  unknown: { label: "Unknown", badge: "outline", className: "text-text-tertiary" },
} as const;

const SERVICE_ICON_BY_KEY = {
  web: GlobeIcon,
  api: NetworkIcon,
  worker: GearSixIcon,
  node: BracketsCurlyIcon,
  postgres: DatabaseIcon,
  redis: StackIcon,
  valkey: StackIcon,
  mongodb: DatabaseIcon,
  temporal: TreeStructureIcon,
  "api-gateway": NetworkIcon,
  aws: CloudIcon,
  "docker-image": PackageIcon,
  upstash: StackIcon,
  database: DatabaseIcon,
  cache: StackIcon,
  service: CubeIcon,
  unknown: WarningDiamondIcon,
} as const;
