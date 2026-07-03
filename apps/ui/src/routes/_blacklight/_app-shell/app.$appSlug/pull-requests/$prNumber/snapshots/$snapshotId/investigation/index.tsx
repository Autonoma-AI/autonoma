import { Badge, Skeleton } from "@autonoma/blacklight";
import type { InvestigationFinding } from "@autonoma/types";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/MagnifyingGlass";
import { createFileRoute } from "@tanstack/react-router";
import { findingCategoryMeta, PASSED_PRIORITY } from "components/investigation/finding-category";
import { useInvestigationReportData } from "lib/query/branches.queries";
import { useState } from "react";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";

export const Route = createFileRoute(
  "/_blacklight/_app-shell/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/investigation/",
)({
  component: InvestigationListPage,
});

function InvestigationListPage() {
  const { prNumber } = Route.useParams();
  return (
    <div className="flex flex-col gap-6">
      <ListHeader prNumber={prNumber} />
      <FindingsList />
    </div>
  );
}

function ListHeader({ prNumber }: { prNumber: number }) {
  return (
    <header className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-text-secondary">
        <AppLink
          to="/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId"
          params={{ prNumber }}
          aria-label="Back to checkpoint report"
          className="inline-flex size-5 shrink-0 items-center justify-center rounded text-text-secondary transition-colors hover:bg-surface-raised hover:text-text-primary"
        >
          <ArrowLeftIcon size={12} />
        </AppLink>
        <MagnifyingGlassIcon size={14} />
        <span className="font-mono text-2xs uppercase tracking-widest">Investigation</span>
      </div>
      <h1 className="text-2xl font-medium tracking-tight text-text-primary">What the investigation agent found</h1>
    </header>
  );
}

function FindingsList() {
  const { snapshotId } = Route.useParams();
  const { data, isPending } = useInvestigationReportData(snapshotId);
  const [showPassed, setShowPassed] = useState(false);

  if (isPending) return <ListSkeleton />;

  if (data == null) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-border-dim bg-surface-base px-6 py-12 text-center">
        <MagnifyingGlassIcon size={28} className="text-text-secondary" />
        <p className="text-sm text-text-secondary">The investigation view is not available for this checkpoint yet.</p>
      </div>
    );
  }

  const sorted = [...data.findings].sort(
    (a, b) => findingCategoryMeta(a.category).priority - findingCategoryMeta(b.category).priority,
  );
  const actionable = sorted.filter((f) => findingCategoryMeta(f.category).priority < PASSED_PRIORITY);
  const passed = sorted.filter((f) => findingCategoryMeta(f.category).priority >= PASSED_PRIORITY);
  const bugCount = data.findings.filter((f) => f.category === "client_bug").length;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-secondary">
        {data.findings.length} {data.findings.length === 1 ? "finding" : "findings"} for {data.appSlug} · PR #
        {data.prNumber}
        {bugCount > 0 ? ` · ${bugCount} ${bugCount === 1 ? "bug" : "bugs"}` : ""}
      </p>

      {actionable.length === 0 ? (
        <p className="rounded-lg border border-border-dim bg-surface-base px-5 py-6 text-sm text-text-secondary">
          No actionable findings - everything the agent checked passed.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {actionable.map((finding) => (
            <FindingRow key={finding.id} finding={finding} />
          ))}
        </ul>
      )}

      {passed.length > 0 && (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => setShowPassed((prev) => !prev)}
            className="self-start font-mono text-2xs uppercase tracking-widest text-text-secondary transition-colors hover:text-text-primary"
          >
            {showPassed ? "Hide" : "Show"} {passed.length} passed
          </button>
          {showPassed && (
            <ul className="flex flex-col gap-2">
              {passed.map((finding) => (
                <FindingRow key={finding.id} finding={finding} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function FindingRow({ finding }: { finding: InvestigationFinding }) {
  const { prNumber, snapshotId } = Route.useParams();
  const meta = findingCategoryMeta(finding.category);
  return (
    <li>
      <AppLink
        to="/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/investigation/$findingId"
        params={{ prNumber, snapshotId, findingId: finding.id }}
        className="flex items-center gap-4 rounded-lg border border-border-dim bg-surface-base px-4 py-3 transition-colors hover:border-border-mid hover:bg-surface-raised"
      >
        <Badge variant={meta.variant} className="shrink-0 font-mono uppercase">
          {meta.label}
        </Badge>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-text-primary">{finding.headline}</p>
          <p className="truncate font-mono text-2xs text-text-secondary">
            {finding.slug}
            {finding.confidence != null ? ` · ${finding.confidence} confidence` : ""}
          </p>
        </div>
        <CaretRightIcon size={14} className="shrink-0 text-text-secondary" />
      </AppLink>
    </li>
  );
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: 5 }, (_, i) => (
        <Skeleton key={i} className="h-16 w-full" />
      ))}
    </div>
  );
}
