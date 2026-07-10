import {
  Badge,
  BrailleSpinner,
  Button,
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeaderCell,
  DataTableRow,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Skeleton,
  cn,
} from "@autonoma/blacklight";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/ArrowClockwise";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { ArrowLineDownIcon } from "@phosphor-icons/react/ArrowLineDown";
import { ArrowLineUpIcon } from "@phosphor-icons/react/ArrowLineUp";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react/ArrowsClockwise";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import { CubeTransparentIcon } from "@phosphor-icons/react/CubeTransparent";
import { HammerIcon } from "@phosphor-icons/react/Hammer";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/MagnifyingGlass";
import { RocketLaunchIcon } from "@phosphor-icons/react/RocketLaunch";
import { TerminalWindowIcon } from "@phosphor-icons/react/TerminalWindow";
import { Link, Navigate, createFileRoute } from "@tanstack/react-router";
import { LogAppFilter } from "components/build-logs/log-app-filter";
import { PreviewLogsTabs } from "components/build-logs/preview-logs-tabs";
import { useAuth } from "lib/auth";
import { formatDate } from "lib/format";
import {
  useAdminPreviewkitEnvironments,
  useDeployPreviewkitMainBranch,
  usePreviewkitDeployableApplications,
  usePreviewkitEnvFactoryDown,
  usePreviewkitEnvFactoryOptions,
  usePreviewkitEnvFactoryUp,
  useRedeployPreviewkitApp,
  useRedeployPreviewkitEnvironment,
} from "lib/query/admin.queries";
import type { RouterOutputs } from "lib/trpc";
import { Suspense, useState } from "react";

type EnvFactoryUpResult = RouterOutputs["admin"]["previewkitEnvFactoryUp"];

export const Route = createFileRoute("/_blacklight/_app-shell/admin/previewkit/")({
  component: AdminPreviewkitPage,
});

type PreviewEnvironment = RouterOutputs["admin"]["listPreviewkitEnvironments"][number];
type PreviewApp = PreviewEnvironment["apps"][number];

// Reconciled environment health -> Badge variant. This is a rollup of the
// per-app (and addon) statuses, derived server-side so the headline badge can
// never contradict the app rows beneath it - e.g. an environment whose apps are
// all ready but whose post-deploy GitHub finalization failed reads "ready", not
// "failed". The raw pipeline status/phase is shown in the badge's tooltip.
const ENV_HEALTH_VARIANT: Record<PreviewEnvironment["health"], "success" | "warn" | "high" | "critical" | "outline"> = {
  ready: "success",
  building: "warn",
  degraded: "high",
  failed: "critical",
  unknown: "outline",
};

// PreviewkitAppStatus -> Badge variant, for the per-app status shown on each app
// row. Ready is green, terminal failures are red, in-flight states are amber,
// and not-yet-started / skipped are neutral.
const APP_STATUS_VARIANT: Record<PreviewApp["status"], "success" | "warn" | "critical" | "neutral"> = {
  ready: "success",
  pending: "neutral",
  building: "warn",
  built: "warn",
  deploying: "warn",
  build_failed: "critical",
  deploy_failed: "critical",
  skipped: "neutral",
};

function AdminPreviewkitPage() {
  const { isAdmin } = useAuth();
  if (!isAdmin) return <Navigate to="/" />;

  return (
    <section className="flex-1 overflow-auto p-6 lg:p-8">
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <header className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2 text-text-tertiary">
            <Link
              to="/admin"
              aria-label="Back to admin"
              className="inline-flex size-5 shrink-0 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-surface-raised hover:text-text-primary"
            >
              <ArrowLeftIcon size={12} />
            </Link>
            <CubeTransparentIcon size={14} />
            <span className="font-mono text-2xs uppercase tracking-widest">Admin</span>
          </div>
          <h1 className="text-xl font-medium tracking-tight text-text-primary">Preview environments</h1>
          <p className="text-xs text-text-secondary">
            Active Previewkit environments across all organizations, with each app's status and live URL. Torn-down
            environments are hidden.
          </p>
        </header>

        <Suspense fallback={<DeployMainBranchSkeleton />}>
          <DeployMainBranchSection />
        </Suspense>

        <Suspense fallback={<TableSkeleton />}>
          <EnvironmentsTable />
        </Suspense>
      </div>
    </section>
  );
}

// Deploys a preview environment from an application's main branch (PR #0).
// Lists applications linked to a GitHub repository with an active installation.
function DeployMainBranchSection() {
  const { data: applications } = usePreviewkitDeployableApplications();
  const deploy = useDeployPreviewkitMainBranch();
  const [applicationId, setApplicationId] = useState("");

  const handleDeploy = () => {
    if (applicationId === "") return;
    deploy.mutate({ applicationId }, { onSuccess: () => setApplicationId("") });
  };

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border-dim bg-surface-base p-4">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-sm font-medium text-text-primary">Deploy main branch</h2>
        <p className="text-2xs text-text-secondary">
          Deploy a preview environment from an application's main branch. Only applications linked to a GitHub
          repository with an active installation are listed.
        </p>
      </div>

      {applications.length === 0 ? (
        <p className="text-2xs text-text-secondary">No applications are linked to an active GitHub installation.</p>
      ) : (
        <div className="flex items-center gap-3">
          <select
            value={applicationId}
            onChange={(e) => setApplicationId(e.target.value)}
            aria-label="Select an application to deploy"
            className="h-9 flex-1 rounded-md border border-border-dim bg-surface-base px-3 text-sm text-text-primary"
          >
            <option value="">Select an application...</option>
            {applications.map((application) => (
              <option key={application.id} value={application.id}>
                {application.organization.name} / {application.name}
              </option>
            ))}
          </select>
          <Button variant="accent" size="sm" disabled={applicationId === "" || deploy.isPending} onClick={handleDeploy}>
            {deploy.isPending ? <BrailleSpinner animation="braille" size="sm" /> : <RocketLaunchIcon size={14} />}
            Deploy
          </Button>
        </div>
      )}
    </div>
  );
}

function DeployMainBranchSkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border-dim bg-surface-base p-4">
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-3 w-80" />
      <div className="flex items-center gap-3">
        <Skeleton className="h-9 flex-1" />
        <Skeleton className="h-9 w-24" />
      </div>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border-dim py-14 text-center">
      <CubeTransparentIcon size={24} className="text-text-tertiary" />
      <p className="text-sm text-text-tertiary">{message}</p>
    </div>
  );
}

function EnvironmentsTable() {
  const { data: environments } = useAdminPreviewkitEnvironments();
  const [query, setQuery] = useState("");
  const [organizationId, setOrganizationId] = useState("");

  if (environments.length === 0) {
    return <EmptyState message="No active preview environments" />;
  }

  // Distinct organizations that actually have active environments, sorted by
  // name - so the filter only lists orgs with something to show.
  const organizations = [
    ...new Map(environments.map((environment) => [environment.organization.id, environment.organization])).values(),
  ].sort((a, b) => a.name.localeCompare(b.name));

  const filtered = filterEnvironments(environments, query, organizationId);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <div className="relative w-full max-w-sm">
          <MagnifyingGlassIcon
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-secondary"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search org, repo, PR, branch, or app..."
            aria-label="Search preview environments"
            className="pl-8"
          />
        </div>
        <select
          value={organizationId}
          onChange={(e) => setOrganizationId(e.target.value)}
          aria-label="Filter by organization"
          className="h-9 shrink-0 rounded-md border border-border-dim bg-surface-base px-3 text-sm text-text-primary"
        >
          <option value="">All organizations</option>
          {organizations.map((organization) => (
            <option key={organization.id} value={organization.id}>
              {organization.name}
            </option>
          ))}
        </select>
        <span className="ml-auto shrink-0 font-mono text-2xs text-text-secondary">
          {filtered.length} of {environments.length}
        </span>
      </div>

      {filtered.length === 0 ? (
        <EmptyState message="No environments match your filters" />
      ) : (
        <div className="overflow-x-auto rounded-md border border-border-dim">
          <DataTable>
            <DataTableHead>
              <DataTableRow>
                <DataTableHeaderCell className="w-8 pl-3" />
                <DataTableHeaderCell>Environment</DataTableHeaderCell>
                <DataTableHeaderCell>Organization</DataTableHeaderCell>
                <DataTableHeaderCell>Health</DataTableHeaderCell>
                <DataTableHeaderCell>Apps</DataTableHeaderCell>
                <DataTableHeaderCell>Updated</DataTableHeaderCell>
                <DataTableHeaderCell align="right" className="pr-3">
                  Actions
                </DataTableHeaderCell>
              </DataTableRow>
            </DataTableHead>
            <DataTableBody>
              {filtered.map((environment) => (
                <EnvironmentRow key={environment.id} environment={environment} />
              ))}
            </DataTableBody>
          </DataTable>
        </div>
      )}
    </div>
  );
}

// Narrows to the selected organization (empty = all), then a case-insensitive
// substring match across the fields an operator is likely to search by: org,
// repo, PR number, branch, namespace, health, and app names.
function filterEnvironments(
  environments: PreviewEnvironment[],
  query: string,
  organizationId: string,
): PreviewEnvironment[] {
  const trimmed = query.trim().toLowerCase();
  return environments.filter((environment) => {
    if (organizationId !== "" && environment.organization.id !== organizationId) return false;
    if (trimmed === "") return true;
    const haystack = [
      environment.organization.name,
      environment.repoFullName,
      environment.headRef,
      environment.namespace,
      environment.health,
      environment.status,
      `pr #${environment.prNumber}`,
      ...environment.apps.map((app) => app.appName),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(trimmed);
  });
}

function RedeployButton({ environmentId }: { environmentId: string }) {
  const redeploy = useRedeployPreviewkitEnvironment();
  return (
    <Button
      variant="outline"
      size="icon-xs"
      disabled={redeploy.isPending}
      onClick={() => redeploy.mutate({ environmentId })}
      aria-label="Redeploy environment"
      title="Redeploy"
    >
      {redeploy.isPending ? <BrailleSpinner animation="braille" size="sm" /> : <ArrowsClockwiseIcon size={12} />}
    </Button>
  );
}

// One environment per table row. The row shows the at-a-glance columns; the
// caret expands a detail row beneath it with the per-app list. The Up / Logs
// toggles reveal the Environment Factory and log panels in that same detail row.
function EnvironmentRow({ environment }: { environment: PreviewEnvironment }) {
  const [showApps, setShowApps] = useState(false);
  const [showEnvFactory, setShowEnvFactory] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const isOpen = showApps || showEnvFactory || showLogs;
  const readyCount = environment.apps.filter((app) => app.status === "ready").length;

  return (
    <>
      <DataTableRow>
        <DataTableCell className="pl-3">
          <button
            type="button"
            onClick={() => setShowApps((open) => !open)}
            aria-label={showApps ? "Collapse apps" : "Expand apps"}
            aria-expanded={showApps}
            className="inline-flex size-5 items-center justify-center rounded text-text-secondary transition-colors hover:bg-surface-raised hover:text-text-primary"
          >
            <CaretRightIcon size={12} className={cn("transition-transform", showApps && "rotate-90")} />
          </button>
        </DataTableCell>
        <DataTableCell>
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-2xs text-text-primary">PR #{environment.prNumber}</span>
            <span className="block max-w-xs truncate font-mono text-3xs text-text-secondary">
              {environment.headRef}
            </span>
          </div>
        </DataTableCell>
        <DataTableCell>
          <span className="font-mono text-2xs text-text-primary">{environment.organization.name}</span>
        </DataTableCell>
        <DataTableCell>
          <Badge
            variant={ENV_HEALTH_VARIANT[environment.health]}
            className="text-3xs"
            title={`Pipeline status: ${environment.phase ?? environment.status}`}
          >
            {environment.health}
          </Badge>
        </DataTableCell>
        <DataTableCell>
          <span className="font-mono text-2xs text-text-secondary">
            {readyCount}/{environment.apps.length}
          </span>
        </DataTableCell>
        <DataTableCell>
          <span className="whitespace-nowrap font-mono text-3xs text-text-secondary">
            {formatDate(environment.updatedAt)}
          </span>
        </DataTableCell>
        <DataTableCell align="right" className="pr-3">
          <div className="flex items-center justify-end gap-1.5">
            <Button
              variant={showEnvFactory ? "secondary" : "outline"}
              size="icon-xs"
              onClick={() => setShowEnvFactory((open) => !open)}
              aria-label="Toggle environment factory up/down"
              title="Environment Factory"
            >
              <ArrowLineUpIcon size={12} />
            </Button>
            <Button
              variant={showLogs ? "secondary" : "outline"}
              size="icon-xs"
              onClick={() => setShowLogs((open) => !open)}
              aria-label="Toggle logs"
              title="Logs"
            >
              <TerminalWindowIcon size={12} />
            </Button>
            <RedeployButton environmentId={environment.id} />
          </div>
        </DataTableCell>
      </DataTableRow>

      {isOpen && (
        <DataTableRow>
          <DataTableCell colSpan={7} className="bg-surface-base p-0">
            {showApps && <AppsDetail apps={environment.apps} environmentId={environment.id} />}
            {/* Manual Environment Factory up/down against this specific preview. */}
            {showEnvFactory && <EnvFactoryPanel environmentId={environment.id} />}
            {/* Lazy-mounted so the SSE streams only open while the panel is visible. */}
            {showLogs && <EnvironmentLogsPanel environment={environment} />}
          </DataTableCell>
        </DataTableRow>
      )}
    </>
  );
}

// The expanded per-app detail for an environment, as its own column-aligned
// table: every configured app with its status, plus its URL when it has one.
function AppsDetail({ apps, environmentId }: { apps: PreviewApp[]; environmentId: string }) {
  if (apps.length === 0) {
    return <p className="border-t border-border-dim px-3 py-2 font-mono text-2xs text-text-secondary">No apps yet</p>;
  }
  return (
    <div className="border-t border-border-dim px-3 py-2">
      <DataTable className="table-fixed">
        <DataTableHead>
          <DataTableRow>
            <DataTableHeaderCell className="w-1/4 pr-3">App</DataTableHeaderCell>
            <DataTableHeaderCell className="w-40 pr-3">Status</DataTableHeaderCell>
            <DataTableHeaderCell className="pr-3">URL</DataTableHeaderCell>
            <DataTableHeaderCell align="right" className="w-20">
              Actions
            </DataTableHeaderCell>
          </DataTableRow>
        </DataTableHead>
        <DataTableBody>
          {apps.map((app) => (
            <AppRow key={app.appName} app={app} environmentId={environmentId} />
          ))}
        </DataTableBody>
      </DataTable>
    </div>
  );
}

// One app row: name, lifecycle status badge, and its live URL when it has one.
// A failed app shows its error instead; one with no URL yet (still building, or
// skipped) shows a muted placeholder.
function AppRow({ app, environmentId }: { app: PreviewApp; environmentId: string }) {
  return (
    <DataTableRow>
      <DataTableCell className="pr-3">
        <span className="block truncate font-mono text-2xs text-text-primary">{app.appName}</span>
      </DataTableCell>
      <DataTableCell className="pr-3">
        <Badge variant={APP_STATUS_VARIANT[app.status]} className="text-3xs">
          {app.status.replace(/_/g, " ")}
        </Badge>
      </DataTableCell>
      <DataTableCell>
        {app.url != null ? (
          <a
            href={app.url}
            target="_blank"
            rel="noreferrer"
            title={app.url}
            className="inline-flex max-w-full items-center gap-1 font-mono text-2xs text-text-secondary hover:text-text-primary hover:underline"
          >
            <ArrowSquareOutIcon size={12} className="shrink-0" />
            <span className="truncate">{app.url}</span>
          </a>
        ) : app.error != null ? (
          <span className="block max-w-md truncate font-mono text-2xs text-status-critical" title={app.error}>
            {app.error}
          </span>
        ) : (
          <span className="font-mono text-2xs text-text-secondary">No URL</span>
        )}
      </DataTableCell>
      <DataTableCell align="right" className="w-20">
        <AppRedeployControl environmentId={environmentId} appName={app.appName} />
      </DataTableCell>
    </DataTableRow>
  );
}

// Per-app redeploy: a compact menu offering the two modes. "Rebuild image"
// rebuilds this app from source at the environment's current head SHA and
// redeploys only it; "Restart pods" re-rolls its existing image (picks up
// changed secrets/env, no build). Sibling apps are untouched either way.
function AppRedeployControl({ environmentId, appName }: { environmentId: string; appName: string }) {
  const redeploy = useRedeployPreviewkitApp();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="icon-xs"
            disabled={redeploy.isPending}
            aria-label={`Redeploy ${appName}`}
            title="Redeploy app"
          >
            {redeploy.isPending ? <BrailleSpinner animation="braille" size="sm" /> : <ArrowsClockwiseIcon size={12} />}
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => redeploy.mutate({ environmentId, app: appName, mode: "rebuild" })}>
          <HammerIcon size={14} className="mr-2" />
          Rebuild image
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => redeploy.mutate({ environmentId, app: appName, mode: "restart" })}>
          <ArrowClockwiseIcon size={14} className="mr-2" />
          Restart pods
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Build + app logs for the environment, always scoped to a single app. The app
// filter sets PreviewLogsTabs' `app` prop (defaulting to the first app), which
// scopes both the build and the runtime stream. The log-stream route is
// addressed by (owner, repo, pr).
function EnvironmentLogsPanel({ environment }: { environment: PreviewEnvironment }) {
  const [owner = "", repo = ""] = environment.repoFullName.split("/");
  const appNames = environment.apps.map((app) => app.appName);
  const [selectedApp, setSelectedApp] = useState<string | undefined>(() => appNames[0]);

  return (
    <div className="flex flex-col gap-2 border-t border-border-dim p-3">
      {appNames.length > 0 && <LogAppFilter apps={appNames} selectedApp={selectedApp} onSelect={setSelectedApp} />}
      <PreviewLogsTabs owner={owner} repo={repo} pr={environment.prNumber} app={selectedApp} />
    </div>
  );
}

// In-memory state for an active provisioned instance, held only while the panel
// is mounted. The down call needs these values back from the up response.
type ActiveInstance = {
  instanceId: string;
  refs: EnvFactoryUpResult["refs"];
  refsToken: string | undefined;
  scenarioId: string;
  sdkUrl: string;
  auth: EnvFactoryUpResult["auth"];
  resolvedVariables: EnvFactoryUpResult["resolvedVariables"];
};

// Runs an Environment Factory "up" against the preview's SDK endpoint, shows the
// returned credentials / cookies, then lets us "down" the same instance. Nothing
// is persisted server-side; all state lives in this component.
function EnvFactoryPanel({ environmentId }: { environmentId: string }) {
  const { data: options, isLoading } = usePreviewkitEnvFactoryOptions(environmentId, true);
  const up = usePreviewkitEnvFactoryUp();
  const down = usePreviewkitEnvFactoryDown();

  // Selection overrides; default to the first scenario / the suggested SDK URL
  // until the operator changes them (no effects needed).
  const [scenarioOverride, setScenarioOverride] = useState("");
  const [sdkUrlOverride, setSdkUrlOverride] = useState<string | undefined>(undefined);
  const [active, setActive] = useState<ActiveInstance | undefined>(undefined);
  const sdkUrlId = `env-factory-sdk-url-${environmentId}`;

  if (isLoading || options == null) {
    return (
      <div className="flex flex-col gap-2 border-t border-border-dim p-3">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }

  if (options.disabledReason != null) {
    return (
      <div className="border-t border-border-dim p-3">
        <p className="text-2xs text-status-warn">{options.disabledReason}</p>
      </div>
    );
  }

  const scenarioId = scenarioOverride !== "" ? scenarioOverride : (options.scenarios[0]?.id ?? "");
  const sdkUrl = sdkUrlOverride ?? options.suggestedSdkUrl ?? "";
  const canRunUp = scenarioId !== "" && sdkUrl !== "" && !up.isPending;

  const handleUp = () => {
    if (!canRunUp) return;
    up.mutate(
      { environmentId, scenarioId, sdkUrl },
      {
        onSuccess: (data) => {
          setActive({
            instanceId: data.instanceId,
            refs: data.refs,
            refsToken: data.refsToken,
            scenarioId,
            sdkUrl,
            auth: data.auth,
            resolvedVariables: data.resolvedVariables,
          });
        },
      },
    );
  };

  const handleDown = () => {
    if (active == null) return;
    down.mutate(
      {
        environmentId,
        scenarioId: active.scenarioId,
        sdkUrl: active.sdkUrl,
        instanceId: active.instanceId,
        refs: active.refs,
        refsToken: active.refsToken,
      },
      { onSuccess: () => setActive(undefined) },
    );
  };

  return (
    <div className="flex flex-col gap-3 border-t border-border-dim bg-surface-base p-3">
      {active == null ? (
        <div className="flex flex-col gap-2">
          <p className="text-2xs text-text-secondary">
            Seed a scenario into this preview and pull back its credentials so you can sign in and reproduce a failure
            by hand. In-memory only - nothing is persisted.
          </p>
          <label className="flex flex-col gap-1">
            <span className="text-3xs uppercase tracking-widest text-text-secondary">Scenario</span>
            <select
              value={scenarioId}
              onChange={(e) => setScenarioOverride(e.target.value)}
              aria-label="Select a scenario"
              className="h-9 rounded-md border border-border-dim bg-surface-base px-3 text-sm text-text-primary"
            >
              {options.scenarios.map((scenario) => (
                <option key={scenario.id} value={scenario.id}>
                  {scenario.name}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-col gap-1">
            <label htmlFor={sdkUrlId} className="text-3xs uppercase tracking-widest text-text-secondary">
              SDK URL
            </label>
            <Input
              id={sdkUrlId}
              value={sdkUrl}
              onChange={(e) => setSdkUrlOverride(e.target.value)}
              placeholder="https://preview.../sdk"
              aria-label="SDK URL"
              className="font-mono text-2xs"
            />
          </div>
          <div className="flex justify-end">
            <Button variant="accent" size="sm" disabled={!canRunUp} onClick={handleUp}>
              {up.isPending ? <BrailleSpinner animation="braille" size="sm" /> : <ArrowLineUpIcon size={14} />}
              Run up
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <span className="font-mono text-2xs text-text-secondary">instance {active.instanceId}</span>
            <Button variant="destructive" size="sm" disabled={down.isPending} onClick={handleDown}>
              {down.isPending ? <BrailleSpinner animation="braille" size="sm" /> : <ArrowLineDownIcon size={14} />}
              Down
            </Button>
          </div>
          <EnvFactoryResult auth={active.auth} resolvedVariables={active.resolvedVariables} refs={active.refs} />
        </div>
      )}
    </div>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}
      aria-label={`Copy ${label}`}
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-3xs text-text-secondary hover:bg-surface-raised hover:text-text-primary"
    >
      <CopyIcon size={11} />
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  const json = JSON.stringify(value, null, 2);
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border-dim bg-surface-void p-2">
      <div className="flex items-center justify-between">
        <span className="text-3xs uppercase tracking-widest text-text-secondary">{label}</span>
        <CopyButton value={json} label={label} />
      </div>
      <pre className="overflow-auto whitespace-pre-wrap break-all font-mono text-3xs text-text-primary">{json}</pre>
    </div>
  );
}

// Renders the credentials returned by an "up": cookies, headers, credentials,
// plus refs / resolved variables for debugging.
function EnvFactoryResult({
  auth,
  resolvedVariables,
  refs,
}: {
  auth: EnvFactoryUpResult["auth"];
  resolvedVariables: EnvFactoryUpResult["resolvedVariables"];
  refs: EnvFactoryUpResult["refs"];
}) {
  const hasAuth = auth != null && ((auth.cookies?.length ?? 0) > 0 || auth.headers != null || auth.credentials != null);

  return (
    <div className="flex flex-col gap-2">
      {!hasAuth && <p className="text-2xs text-text-secondary">The up call returned no auth payload.</p>}
      {auth?.cookies != null && auth.cookies.length > 0 && <JsonBlock label="Cookies" value={auth.cookies} />}
      {auth?.headers != null && <JsonBlock label="Headers" value={auth.headers} />}
      {auth?.credentials != null && <JsonBlock label="Credentials" value={auth.credentials} />}
      {refs != null && <JsonBlock label="Refs" value={refs} />}
      {Object.keys(resolvedVariables).length > 0 && <JsonBlock label="Resolved variables" value={resolvedVariables} />}
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <Skeleton className="h-9 w-full max-w-sm" />
        <Skeleton className="ml-auto h-4 w-16" />
      </div>
      <div className="flex flex-col gap-2 rounded-md border border-border-dim p-2">
        {[1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>
    </div>
  );
}
