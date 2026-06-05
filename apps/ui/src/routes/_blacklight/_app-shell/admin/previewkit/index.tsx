import { Badge, BrailleSpinner, Button, Skeleton } from "@autonoma/blacklight";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react/ArrowsClockwise";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { CubeTransparentIcon } from "@phosphor-icons/react/CubeTransparent";
import { Link, Navigate, createFileRoute } from "@tanstack/react-router";
import { useAuth } from "lib/auth";
import { formatDate } from "lib/format";
import { useAdminPreviewkitEnvironments, useRedeployPreviewkitEnvironment } from "lib/query/admin.queries";
import type { RouterOutputs } from "lib/trpc";
import { Suspense, useState } from "react";

export const Route = createFileRoute("/_blacklight/_app-shell/admin/previewkit/")({
  component: AdminPreviewkitPage,
});

type PreviewEnvironment = RouterOutputs["admin"]["listPreviewkitEnvironments"][number];

// PreviewkitStatus -> Badge variant. torn_down never appears (filtered server-side)
// but is mapped so the record stays exhaustive over the enum.
const STATUS_VARIANT: Record<PreviewEnvironment["status"], "success" | "warn" | "critical" | "outline"> = {
  ready: "success",
  building: "warn",
  deploying: "warn",
  pending: "warn",
  failed: "critical",
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

        <Suspense fallback={<TableSkeleton />}>
          <EnvironmentsTable />
        </Suspense>
      </div>
    </section>
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
