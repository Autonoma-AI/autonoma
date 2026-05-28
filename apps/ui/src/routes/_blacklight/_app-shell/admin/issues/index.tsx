import { Badge, Skeleton } from "@autonoma/blacklight";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { ShieldWarningIcon } from "@phosphor-icons/react/ShieldWarning";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, Navigate, createFileRoute } from "@tanstack/react-router";
import { useAuth } from "lib/auth";
import { formatDate } from "lib/format";
import type { RouterOutputs } from "lib/trpc";
import { trpc } from "lib/trpc";
import { Suspense } from "react";

export const Route = createFileRoute("/_blacklight/_app-shell/admin/issues/")({
  component: AdminIssuesPage,
});

function AdminIssuesPage() {
  const { isAdmin } = useAuth();
  if (!isAdmin) return <Navigate to="/" />;

  return (
    <section className="flex-1 overflow-auto p-6 lg:p-8">
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <header className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2 text-text-tertiary">
            <Link
              to="/admin"
              aria-label="Back to admin"
              className="inline-flex size-5 shrink-0 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-surface-raised hover:text-text-primary"
            >
              <ArrowLeftIcon size={12} />
            </Link>
            <ShieldWarningIcon size={14} />
            <span className="font-mono text-2xs uppercase tracking-widest">Admin</span>
          </div>
          <h1 className="text-xl font-medium tracking-tight text-text-primary">Engine limitations</h1>
          <p className="text-xs text-text-secondary">
            Engine-limitation issues across this organization. Each row links to the snapshot that surfaced it.
          </p>
        </header>

        <Suspense fallback={<TableSkeleton />}>
          <IssuesTable />
        </Suspense>
      </div>
    </section>
  );
}

type Issue = RouterOutputs["issues"]["list"][number];

function IssuesTable() {
  const { data: issues } = useSuspenseQuery(trpc.issues.list.queryOptions({ kind: "engine_limitation" }));

  if (issues.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border-dim py-14 text-center">
        <ShieldWarningIcon size={24} className="text-text-tertiary" />
        <p className="text-sm text-text-tertiary">No engine-limitation issues</p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-md border border-border-dim">
      <table className="w-full text-sm">
        <thead className="bg-surface-base">
          <tr className="text-left font-mono text-2xs uppercase tracking-widest text-text-tertiary">
            <th className="px-3 py-2 font-medium">Created</th>
            <th className="px-3 py-2 font-medium">App</th>
            <th className="px-3 py-2 font-medium">Test</th>
            <th className="px-3 py-2 font-medium">Summary</th>
            <th className="px-3 py-2 font-medium">Severity</th>
            <th className="px-3 py-2 font-medium">Snapshot</th>
          </tr>
        </thead>
        <tbody>
          {issues.map((issue) => (
            <IssueRow key={issue.id} issue={issue} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

const SEVERITY_VARIANT: Record<Issue["severity"], "critical" | "high" | "warn" | "outline"> = {
  critical: "critical",
  high: "high",
  medium: "warn",
  low: "outline",
};

function IssueRow({ issue }: { issue: Issue }) {
  return (
    <tr className="border-t border-border-dim text-text-secondary">
      <td className="px-3 py-2 text-2xs text-text-tertiary">{formatDate(issue.createdAt)}</td>
      <td className="px-3 py-2 font-mono text-xs text-text-primary">{issue.application?.name ?? "-"}</td>
      <td className="px-3 py-2 font-mono text-xs text-text-secondary">{issue.testName}</td>
      <td className="px-3 py-2 text-xs text-text-secondary">{issue.title}</td>
      <td className="px-3 py-2">
        <Badge variant={SEVERITY_VARIANT[issue.severity]} className="text-3xs">
          {issue.severity}
        </Badge>
      </td>
      <td className="px-3 py-2">
        {issue.snapshot != null && issue.application != null ? (
          <Link
            to="/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId"
            params={{
              appSlug: issue.application.slug,
              prNumber: issue.snapshot.prNumber,
              snapshotId: issue.snapshot.snapshotId,
            }}
            className="font-mono text-2xs uppercase tracking-widest text-text-tertiary hover:text-text-primary hover:underline"
          >
            view
          </Link>
        ) : (
          <span className="font-mono text-2xs uppercase tracking-widest text-text-tertiary">-</span>
        )}
      </td>
    </tr>
  );
}

function TableSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      {[1, 2, 3, 4].map((i) => (
        <Skeleton key={i} className="h-10 w-full rounded-md" />
      ))}
    </div>
  );
}
