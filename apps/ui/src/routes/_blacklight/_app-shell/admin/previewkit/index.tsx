import { Badge, BrailleSpinner, Button, Skeleton } from "@autonoma/blacklight";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react/ArrowsClockwise";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { CubeTransparentIcon } from "@phosphor-icons/react/CubeTransparent";
import { RocketLaunchIcon } from "@phosphor-icons/react/RocketLaunch";
import { TerminalWindowIcon } from "@phosphor-icons/react/TerminalWindow";
import { Link, Navigate, createFileRoute } from "@tanstack/react-router";
import { PreviewLogsTabs } from "components/build-logs/preview-logs-tabs";
import { useAuth } from "lib/auth";
import { formatDate } from "lib/format";
import {
  useAdminPreviewkitEnvironments,
  useDeployPreviewkitMainBranch,
  usePreviewkitDeployableApplications,
  useRedeployPreviewkitEnvironment,
} from "lib/query/admin.queries";
import type { RouterOutputs } from "lib/trpc";
import { Suspense, useState } from "react";

export const Route = createFileRoute("/_blacklight/_app-shell/admin/previewkit/")({
  component: AdminPreviewkitPage,
});

type PreviewEnvironment = RouterOutputs["admin"]["listPreviewkitEnvironments"][number];

// PreviewkitStatus -> Badge variant. torn_down (filtered server-side) and
// superseded (only ever written to a build row, never to an environment row)
// never appear here, but are mapped so the record stays exhaustive over the enum.
const STATUS_VARIANT: Record<PreviewEnvironment["status"], "success" | "warn" | "critical" | "outline"> = {
  ready: "success",
  building: "warn",
  deploying: "warn",
  pending: "warn",
  failed: "critical",
  superseded: "outline",
  torn_down: "outline",
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
            Active Previewkit environments across all organizations, with their live URLs. Torn-down environments are
            hidden.
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
  // Empty = no organization chosen yet. Results only render once one is picked.
  const [organizationId, setOrganizationId] = useState("");

  if (environments.length === 0) {
    return <EmptyState message="No active preview environments" />;
  }

  // Distinct organizations that actually have active environments, sorted by
  // name. Deriving the options from the rows keeps the selector free of orgs
  // with nothing to show.
  const organizations = [
    ...new Map(environments.map((environment) => [environment.organization.id, environment.organization])).values(),
  ].sort((a, b) => a.name.localeCompare(b.name));

  const hasSelection = organizationId !== "";
  const selectedEnvironments = hasSelection
    ? environments.filter((environment) => environment.organization.id === organizationId)
    : [];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        {hasSelection && (
          <p className="text-2xs text-text-tertiary">
            {selectedEnvironments.length} {selectedEnvironments.length === 1 ? "environment" : "environments"}
          </p>
        )}
        <select
          value={organizationId}
          onChange={(e) => setOrganizationId(e.target.value)}
          aria-label="Filter by organization"
          className="ml-auto h-9 rounded-md border border-border-dim bg-surface-base px-3 text-sm text-text-primary"
        >
          <option value="">Select an organization...</option>
          {organizations.map((organization) => (
            <option key={organization.id} value={organization.id}>
              {organization.name}
            </option>
          ))}
        </select>
      </div>

      {!hasSelection ? (
        <EmptyState message="Select an organization to view its preview environments" />
      ) : selectedEnvironments.length === 0 ? (
        <EmptyState message="No environments for the selected organization" />
      ) : (
        <div className="flex flex-col gap-3">
          {selectedEnvironments.map((environment) => (
            <EnvironmentCard key={environment.id} environment={environment} />
          ))}
        </div>
      )}
    </div>
  );
}

function RedeployButton({ environmentId }: { environmentId: string }) {
  const redeploy = useRedeployPreviewkitEnvironment();
  return (
    <Button
      variant="outline"
      size="xs"
      disabled={redeploy.isPending}
      onClick={() => redeploy.mutate({ environmentId })}
      aria-label="Redeploy environment"
    >
      {redeploy.isPending ? <BrailleSpinner animation="braille" size="sm" /> : <ArrowsClockwiseIcon size={12} />}
      Redeploy
    </Button>
  );
}

function EnvironmentCard({ environment }: { environment: PreviewEnvironment }) {
  const [showLogs, setShowLogs] = useState(false);
  // The log-stream route is addressed by (owner, repo, pr).
  const [owner = "", repo = ""] = environment.repoFullName.split("/");

  return (
    <div className="overflow-hidden rounded-md border border-border-dim">
      {/* Branch / environment information. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border-dim bg-surface-base px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs">PR #{environment.prNumber}</span>
          <span className="font-mono text-2xs text-text-secondary">{environment.headRef}</span>
        </div>
        <div className="flex gap-4 ml-auto items-center">
          <span className="ml-auto text-2xs text-text-tertiary">{formatDate(environment.updatedAt)}</span>
          <Badge variant={STATUS_VARIANT[environment.status]} className="text-3xs">
            {environment.phase ?? environment.status}
          </Badge>
          <Button
            variant={showLogs ? "secondary" : "outline"}
            size="xs"
            onClick={() => setShowLogs((open) => !open)}
            aria-label="Toggle logs"
          >
            <TerminalWindowIcon size={12} />
            Logs
          </Button>
          <RedeployButton environmentId={environment.id} />
        </div>
      </div>

      {/* Apps: name + URL per entry, no columns. */}
      {environment.apps.length === 0 ? (
        <p className="px-3 py-2 font-mono text-2xs text-text-tertiary">No URLs yet</p>
      ) : (
        <div className="divide-y divide-border-dim">
          {environment.apps.map((app) => (
            <div key={app.appName} className="items-center gap-x-3 gap-y-0.5 px-3 py-2 grid grid-cols-2">
              <span className="font-mono text-xs text-text-primary">{app.appName}</span>
              <a
                href={app.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-mono text-2xs text-text-tertiary hover:text-text-primary hover:underline"
              >
                <ArrowSquareOutIcon size={12} className="shrink-0" />
                <span className="truncate">{app.url}</span>
              </a>
            </div>
          ))}
        </div>
      )}

      {/* Lazy-mounted so the SSE streams only open while the panel is visible. */}
      {showLogs && (
        <PreviewLogsTabs
          owner={owner}
          repo={repo}
          pr={environment.prNumber}
          className="border-t border-border-dim p-3"
        />
      )}
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      {[1, 2, 3, 4].map((i) => (
        <Skeleton key={i} className="h-12 w-full rounded-md" />
      ))}
    </div>
  );
}
