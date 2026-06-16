import { Badge, Button, Skeleton, StatusDot, cn } from "@autonoma/blacklight";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { GearSixIcon } from "@phosphor-icons/react/GearSix";
import { GitBranchIcon } from "@phosphor-icons/react/GitBranch";
import { GlobeIcon } from "@phosphor-icons/react/Globe";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { PreviewLogsTabs } from "components/build-logs/preview-logs-tabs";
import { formatRelativeTime } from "lib/format";
import { ensurePreviewEnvironmentSummaryData, usePreviewEnvironmentSummary } from "lib/query/deployments.queries";
import { useApplicationRepositoryFromGitHub } from "lib/query/github.queries";
import type { RouterOutputs } from "lib/trpc";
import { type ReactNode, Suspense, useState } from "react";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";
import { useCurrentApplication } from "routes/_blacklight/_app-shell/-use-current-application";
import { PREVIEW_STATUS_META, SERVICE_ICON_BY_KEY, SERVICE_STATUS_META } from "../-components/preview-status-meta";

type PreviewSummary = RouterOutputs["deployments"]["previewSummaryByPr"];
type PreviewService = PreviewSummary["services"][number];

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/pull-requests/$prNumber/preview")({
  loader: async ({ context, params: { appSlug, prNumber } }) => {
    const app = context.applications.find((a) => a.slug === appSlug);
    if (app == null) throw notFound();
    await ensurePreviewEnvironmentSummaryData(context.queryClient, app.id, prNumber);
  },
  component: PreviewEnvironmentPage,
});

function PreviewEnvironmentPage() {
  const { prNumber } = Route.useParams();

  return (
    <div className="flex h-full flex-col gap-6">
      <Suspense fallback={<PreviewEnvironmentPageSkeleton />}>
        <PreviewEnvironmentContent prNumber={prNumber} />
      </Suspense>
    </div>
  );
}

function PreviewEnvironmentContent({ prNumber }: { prNumber: number }) {
  const app = useCurrentApplication();
  const { data: summary } = usePreviewEnvironmentSummary(app.id, prNumber, { refetchWhileActive: true });
  const statusMeta = PREVIEW_STATUS_META[summary.status] ?? PREVIEW_STATUS_META.unknown;
  const previewHref = summary.actions.openPreview.enabled ? (summary.actions.openPreview.href ?? undefined) : undefined;

  return (
    <>
      <PreviewHeader prNumber={prNumber} summary={summary} statusMeta={statusMeta} />

      {summary.source !== "previewkit" ? (
        <PreviewUnavailable summary={summary} previewHref={previewHref} />
      ) : (
        <PreviewServicesExplorer summary={summary} applicationId={app.id} prNumber={prNumber} />
      )}
    </>
  );
}

function PreviewHeader({
  prNumber,
  summary,
  statusMeta,
}: {
  prNumber: number;
  summary: PreviewSummary;
  statusMeta: (typeof PREVIEW_STATUS_META)[keyof typeof PREVIEW_STATUS_META];
}) {
  // Every app shares the PR branch, so show it once for the whole environment.
  const branch = summary.services.find((service) => service.branch != null)?.branch;

  return (
    <header className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2 text-text-secondary">
          <AppLink
            to="/app/$appSlug/pull-requests/$prNumber"
            params={{ prNumber }}
            aria-label="Back to pull request"
            className="inline-flex size-5 shrink-0 items-center justify-center rounded text-text-secondary transition-colors hover:bg-surface-raised hover:text-text-primary"
          >
            <ArrowLeftIcon size={12} />
          </AppLink>
          <GlobeIcon size={14} />
          <span className="font-mono text-2xs uppercase tracking-widest">Preview environment</span>
          <span className="font-mono text-2xs">#{prNumber}</span>
        </div>
        <h1 className="text-2xl font-medium tracking-tight text-text-primary">Preview environment</h1>
        {branch != null && (
          <div className="flex items-center gap-1.5 font-mono text-2xs text-text-secondary">
            <GitBranchIcon size={12} className="shrink-0" />
            <span className="truncate">{branch}</span>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Badge variant={statusMeta.badge} className={cn("gap-1.5", statusMeta.className)}>
          <StatusDot status={statusMeta.dot} className="rounded-full" />
          {statusMeta.label}
        </Badge>
        <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-2xs uppercase tracking-wider text-text-secondary">
          {summary.deployedAt != null && <span>Deployed {formatRelativeTime(summary.deployedAt)}</span>}
          {summary.lastDeployedSha != null && <span>SHA {summary.lastDeployedSha.slice(0, 7)}</span>}
          {summary.phase != null && <span>{summary.phase}</span>}
        </div>
      </div>

      {summary.error != null && <p className="text-sm text-status-critical">{summary.error}</p>}
    </header>
  );
}

function PreviewUnavailable({ summary, previewHref }: { summary: PreviewSummary; previewHref: string | undefined }) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 border border-dashed border-border-mid bg-surface-base px-6 py-20 text-center">
      <div className="flex size-12 items-center justify-center rounded-full border border-border-mid bg-surface-raised text-text-secondary">
        <GlobeIcon size={22} />
      </div>
      <div className="flex max-w-md flex-col gap-1.5">
        <h2 className="text-lg font-semibold text-text-primary">No preview environment</h2>
        <p className="text-sm text-text-secondary">
          {summary.error ?? "This pull request does not have a preview environment."}
        </p>
      </div>
      {previewHref != null && (
        <a href={previewHref} target="_blank" rel="noreferrer">
          <Button variant="outline" size="sm">
            <ArrowSquareOutIcon size={12} />
            Open deployment
          </Button>
        </a>
      )}
    </div>
  );
}

// Master-detail: the environment's services on the left, the selected service's details plus the
// environment build/app logs on the right.
function PreviewServicesExplorer({
  summary,
  applicationId,
  prNumber,
}: {
  summary: PreviewSummary;
  applicationId: string;
  prNumber: number;
}) {
  const services = summary.services;
  const apps = services.filter(isAppService);
  const dependencies = services.filter((service) => !isAppService(service));
  const [selectedKey, setSelectedKey] = useState<string | undefined>(() =>
    services[0] != null ? serviceKey(services[0]) : undefined,
  );
  const selectedService = services.find((service) => serviceKey(service) === selectedKey) ?? services[0];
  const onSelect = (service: PreviewService) => setSelectedKey(serviceKey(service));

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
        {selectedService != null && <PreviewAppDetail service={selectedService} />}
        <PreviewLogsSection service={selectedService} applicationId={applicationId} prNumber={prNumber} />
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

function PreviewAppDetail({ service }: { service: PreviewService }) {
  const Icon = SERVICE_ICON_BY_KEY[service.iconKey] ?? GearSixIcon;
  const statusMeta = SERVICE_STATUS_META[service.status] ?? SERVICE_STATUS_META.unknown;

  return (
    <div className="shrink-0 border border-border-dim bg-surface-base">
      <div className="flex items-center gap-3 border-b border-border-dim px-4 py-3">
        <Icon size={18} className="shrink-0 text-text-secondary" />
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
        <DetailRow label="URL">
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
        <DetailRow label="Last built">
          {service.lastBuiltAt != null ? formatRelativeTime(service.lastBuiltAt) : "-"}
        </DetailRow>
      </dl>

      {service.statusReason != null && (
        <div className="border-t border-border-dim px-4 py-3 text-xs text-status-critical">{service.statusReason}</div>
      )}
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="font-mono text-2xs uppercase tracking-wider text-text-secondary">{label}</dt>
      <dd className="min-w-0 text-sm text-text-primary">{children}</dd>
    </div>
  );
}

function PreviewLogsSection({
  service,
  applicationId,
  prNumber,
}: {
  service: PreviewService | undefined;
  applicationId: string;
  prNumber: number;
}) {
  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3">
      <h2 className="text-sm font-semibold text-text-primary">Logs</h2>
      <PreviewLogsBody service={service} applicationId={applicationId} prNumber={prNumber} />
    </section>
  );
}

function PreviewLogsBody({
  service,
  applicationId,
  prNumber,
}: {
  service: PreviewService | undefined;
  applicationId: string;
  prNumber: number;
}) {
  const repository = useApplicationRepositoryFromGitHub(applicationId);
  const fullName = repository.data?.fullName;

  // Build and runtime logs are labeled per app (web/api/worker). Addons and managed services run
  // outside the build/deploy pipeline, so they carry no per-app logs.
  if (service != null && !isAppService(service)) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center border border-border-dim bg-surface-base px-4 py-5 text-center text-sm text-text-secondary">
        No build or runtime logs for this service.
      </div>
    );
  }

  if (fullName == null) {
    if (repository.isPending) return <Skeleton className="min-h-0 w-full flex-1" />;
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center border border-border-dim bg-surface-base px-4 py-5 text-center text-sm text-text-secondary">
        Logs are unavailable - this application is not linked to a GitHub repository.
      </div>
    );
  }

  const [owner = "", repo = ""] = fullName.split("/");
  return (
    <PreviewLogsTabs
      owner={owner}
      repo={repo}
      pr={prNumber}
      app={service?.name}
      appBuilding={service?.status === "building"}
      fill
      className="border border-border-dim bg-surface-base p-3"
    />
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
      </div>
    </>
  );
}
