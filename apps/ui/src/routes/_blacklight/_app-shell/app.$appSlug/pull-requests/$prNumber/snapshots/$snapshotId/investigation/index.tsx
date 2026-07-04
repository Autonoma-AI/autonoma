import { Badge, Separator, Skeleton } from "@autonoma/blacklight";
import type { InvestigationFinding, InvestigationSuggestedTest } from "@autonoma/types";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { FlaskIcon } from "@phosphor-icons/react/Flask";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/MagnifyingGlass";
import { createFileRoute } from "@tanstack/react-router";
import { findingCategoryMeta, PASSED_PRIORITY } from "components/investigation/finding-category";
import { useInvestigationReport, useInvestigationReportData } from "lib/query/branches.queries";
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
  // Presence (status) so the empty state can tell "still running" apart from "no renderable report". It resolves
  // independently from the data query, so we also wait for it to settle before choosing the empty-state copy -
  // otherwise a running report could flash "not available" before flipping. `isLoading` (not `isPending`) so a
  // disabled query for a non-internal user doesn't wedge the skeleton on.
  const { data: presence, isLoading: presenceLoading } = useInvestigationReport(snapshotId);
  const [showPassed, setShowPassed] = useState(false);

  if (isPending) return <ListSkeleton />;

  if (data == null) {
    if (presenceLoading) return <ListSkeleton />;
    const isRunning = presence?.status === "running";
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-border-dim bg-surface-base px-6 py-12 text-center">
        <MagnifyingGlassIcon size={28} className="text-text-secondary" />
        <p className="text-sm text-text-secondary">
          {isRunning
            ? "The investigation is still running - findings will appear here once it finishes."
            : "The investigation view is not available for this checkpoint yet."}
        </p>
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

      {data.suggested.length > 0 && (
        <>
          <Separator className="my-2" />
          <ProposedTests suggested={data.suggested} />
        </>
      )}
    </div>
  );
}

/**
 * The agent's proposed NEW tests (distinct from the findings above, which classify existing tests). Each is a
 * gap the run surfaced but no test yet guards - shown read-only with its rationale and whether the twin re-ran
 * and validated it. Persisted in the report island (InvestigationSuggestedTest), so this is display-only.
 */
function ProposedTests({ suggested }: { suggested: InvestigationSuggestedTest[] }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-text-secondary">
        <FlaskIcon size={14} />
        <span className="font-mono text-2xs uppercase tracking-widest">
          {suggested.length} proposed {suggested.length === 1 ? "test" : "tests"}
        </span>
      </div>
      <ul className="flex flex-col gap-2">
        {suggested.map((test, i) => (
          <ProposalCard key={i} test={test} />
        ))}
      </ul>
    </section>
  );
}

function ProposalCard({ test }: { test: InvestigationSuggestedTest }) {
  const failureReason = test.validation?.passed === false ? test.validation.failureReason : undefined;
  return (
    <li className="flex flex-col gap-3 rounded-lg border border-border-dim bg-surface-base px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-text-primary">{test.name}</p>
        <ProposalValidation validation={test.validation} />
      </div>
      {test.reasoning !== "" && <p className="text-sm leading-relaxed text-text-secondary">{test.reasoning}</p>}
      {failureReason != null && failureReason !== "" && (
        <p className="text-2xs leading-relaxed text-status-critical">{failureReason}</p>
      )}
      {test.instruction !== "" && (
        <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-surface-void p-3 font-mono text-2xs text-text-secondary">
          {test.instruction}
        </pre>
      )}
    </li>
  );
}

function ProposalValidation({ validation }: { validation: InvestigationSuggestedTest["validation"] }) {
  if (validation == null) {
    return (
      <Badge variant="outline" className="shrink-0 font-mono uppercase">
        Not validated
      </Badge>
    );
  }
  if (validation.passed) {
    return (
      <Badge variant="success" className="shrink-0 font-mono uppercase">
        Validated{validation.iterations > 0 ? ` · ${validation.iterations}×` : ""}
      </Badge>
    );
  }
  return (
    <Badge variant="critical" className="shrink-0 font-mono uppercase">
      Validation failed
    </Badge>
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
