import { Button, Skeleton, StatusDot } from "@autonoma/blacklight";
import { ClockCounterClockwiseIcon } from "@phosphor-icons/react/ClockCounterClockwise";
import { GitBranchIcon } from "@phosphor-icons/react/GitBranch";
import { GitCommitIcon } from "@phosphor-icons/react/GitCommit";
import { ListNumbersIcon } from "@phosphor-icons/react/ListNumbers";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { formatDate, formatRelativeTime } from "lib/format";
import { ensureBranchSnapshotId } from "lib/query/branches.queries";
import { useTestCaseRuns } from "lib/query/runs.queries";
import { ensureTestDetailData } from "lib/query/tests.queries";
import type { RouterOutputs } from "lib/trpc";
import { trpc } from "lib/trpc";
import { Suspense } from "react";
import { useSelectedBranch } from "../-use-selected-branch";
import { AppLink } from "../../-app-link";
import { useCurrentApplication } from "../../-use-current-application";
import { useTestChanges } from "./-use-test-changes";

type TestRun = RouterOutputs["runs"]["listForTestCase"][number];
type RunStatus = TestRun["status"];

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/tests/$testSlug")({
  loaderDeps: ({ search }: { search: { branch?: string } }) => ({ branch: search.branch }),
  loader: async ({ context, params: { appSlug, testSlug }, deps: { branch } }) => {
    const app = context.applications.find((a: { slug: string }) => a.slug === appSlug);
    if (app == null) throw notFound();

    const branchName = branch ?? app.mainBranch.name;
    const snapshotId = await ensureBranchSnapshotId(context.queryClient, app.id, branchName);
    if (snapshotId == null) throw notFound();

    return ensureTestDetailData(context.queryClient, app.id, testSlug, snapshotId);
  },
  pendingComponent: TestDetailSkeleton,
  notFoundComponent: NotFoundTest,
  component: TestSlugPage,
});

function TestSlugPage() {
  const { testSlug } = Route.useParams();
  return (
    <div className="flex-1 overflow-y-auto">
      <Suspense fallback={<TestDetailSkeleton />}>
        <TestDetailPanel key={testSlug} slug={testSlug} />
      </Suspense>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-4 flex items-center gap-3.5">
      <span className="font-mono text-2xs font-bold uppercase tracking-widest text-text-secondary">{children}</span>
      <span className="h-px flex-1 bg-border-dim" />
    </div>
  );
}

function TestDetailPanel({ slug }: { slug: string }) {
  const currentApp = useCurrentApplication();
  const branch = useSelectedBranch();
  const snapshotId = branch.activeSnapshot.id;

  const { data: test } = useSuspenseQuery(
    trpc.tests.detail.queryOptions({ applicationId: currentApp.id, slug, snapshotId }),
  );

  const changeStatus = useTestChanges().byTestId.get(test.id);
  const plan = test.prompt?.trim() ?? "";

  return (
    <div>
      <header className="border-b border-border-dim px-11 pb-7 pt-9">
        <div className="flex flex-wrap items-center gap-3.5">
          <h1 className="font-mono text-xl font-semibold tracking-tight text-text-primary">{test.name}</h1>
          {changeStatus != null && <ChangeChip status={changeStatus} />}
        </div>

        {test.description != null && test.description.length > 0 && (
          <p className="mt-4 max-w-2xl text-sm leading-relaxed text-text-primary">{test.description}</p>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-4 font-mono text-xs text-text-secondary">
          <span className="flex items-center gap-1.5">
            <ListNumbersIcon size={13} />
            {test.steps.length} {test.steps.length === 1 ? "step" : "steps"}
          </span>
          <span className="flex items-center gap-1.5">
            <ClockCounterClockwiseIcon size={13} />
            Created {formatDate(test.createdAt)}
          </span>
        </div>
      </header>

      <div className="flex flex-col items-start gap-11 px-11 pb-11 pt-8 lg:flex-row">
        <div className="min-w-0 flex-1">
          <SectionLabel>Plan</SectionLabel>
          {plan.length > 0 ? (
            <pre className="overflow-x-auto whitespace-pre-wrap border border-border-dim bg-surface-void p-5 font-mono text-xs leading-relaxed text-text-primary">
              {plan}
            </pre>
          ) : (
            <p className="border border-dashed border-border-mid px-4 py-8 text-center text-sm text-text-secondary">
              No plan text for this test.
            </p>
          )}
        </div>

        <aside className="w-full shrink-0 border border-border-dim bg-surface-base p-5 lg:sticky lg:top-0 lg:w-88">
          <SectionLabel>Latest runs</SectionLabel>
          <RunsList testCaseId={test.id} />
        </aside>
      </div>
    </div>
  );
}

function ChangeChip({ status }: { status: "added" | "modified" }) {
  return (
    <span className="flex items-center gap-1.5 border border-border-dim px-2 py-1 font-mono text-3xs uppercase tracking-wide text-text-secondary">
      <span className="size-1.5 shrink-0 bg-primary" />
      {status === "added" ? "New on this branch" : "Modified on this branch"}
    </span>
  );
}

const RUN_STATUS: Record<RunStatus, { label: string; dot: "success" | "critical" | "warn" | "neutral" }> = {
  success: { label: "Passed", dot: "success" },
  failed: { label: "Failed", dot: "critical" },
  running: { label: "Running", dot: "warn" },
  pending: { label: "Pending", dot: "neutral" },
};

function RunsList({ testCaseId }: { testCaseId: string }) {
  const { data: runs, isLoading, isError, refetch } = useTestCaseRuns(testCaseId);

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4">
        {["r1", "r2", "r3"].map((id) => (
          <Skeleton key={id} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  // A failed fetch must not read as "no history" - surface it with a retry so an empty panel always means empty.
  if (isError) {
    return (
      <div className="flex flex-col items-start gap-2 py-6">
        <p className="text-sm text-text-secondary">Couldn&apos;t load runs for this test.</p>
        <Button variant="outline" size="sm" onClick={() => void refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  if (runs == null || runs.length === 0) {
    return <p className="py-6 text-sm text-text-secondary">No runs yet for this test.</p>;
  }

  return (
    <div className="flex flex-col">
      {runs.map((run) => (
        <RunRow key={run.id} run={run} />
      ))}
    </div>
  );
}

function RunRow({ run }: { run: TestRun }) {
  const status = RUN_STATUS[run.status];

  return (
    <AppLink
      to="/app/$appSlug/runs/$runId"
      params={{ runId: run.id }}
      className="flex cursor-pointer flex-col gap-2.5 border-b border-border-dim py-4 last:border-b-0"
    >
      <div className="flex items-center gap-2.5">
        <StatusDot status={status.dot} />
        <span className="font-mono text-xs text-text-secondary">{status.label}</span>
        {run.duration != null && <span className="font-mono text-xs text-text-secondary">· {run.duration}</span>}
        <span className="ml-auto font-mono text-xs text-text-secondary">
          {formatRelativeTime(new Date(run.createdAt))}
        </span>
      </div>

      {run.prNumber != null && (
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 font-mono text-xs text-primary-ink">#{run.prNumber}</span>
          {run.prTitle != null && <span className="truncate text-sm text-text-primary">{run.prTitle}</span>}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 font-mono text-3xs text-text-secondary">
        {run.sha != null && (
          <span className="flex items-center gap-1">
            <GitCommitIcon size={12} />
            {run.sha}
          </span>
        )}
        {run.author != null && <span>{run.author}</span>}
        <span className="flex items-center gap-1">
          <GitBranchIcon size={11} />
          {run.branchName}
        </span>
      </div>
    </AppLink>
  );
}

function TestDetailSkeleton() {
  return (
    <div className="p-11">
      <Skeleton className="mb-4 h-7 w-64" />
      <Skeleton className="mb-2 h-4 w-full max-w-xl" />
      <Skeleton className="mb-8 h-4 w-3/4 max-w-md" />
      <div className="flex flex-col gap-11 lg:flex-row">
        <div className="flex flex-1 flex-col gap-3">
          <Skeleton className="h-64 w-full" />
        </div>
        <div className="w-full lg:w-88">
          <Skeleton className="h-48 w-full" />
        </div>
      </div>
    </div>
  );
}

function NotFoundTest() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <p className="text-sm font-medium text-text-primary">Test not found</p>
      <p className="text-sm text-text-secondary">
        This test may not exist on the selected branch, or the slug is incorrect.
      </p>
      <AppLink
        to="/app/$appSlug/tests"
        className="mt-2 font-mono text-2xs font-semibold uppercase tracking-widest text-text-primary transition-colors hover:underline"
      >
        Back to tests
      </AppLink>
    </div>
  );
}
