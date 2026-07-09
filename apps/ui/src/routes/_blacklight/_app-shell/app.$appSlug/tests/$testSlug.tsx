import { Skeleton } from "@autonoma/blacklight";
import { ClockCounterClockwiseIcon } from "@phosphor-icons/react/ClockCounterClockwise";
import { ListNumbersIcon } from "@phosphor-icons/react/ListNumbers";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { formatDate } from "lib/format";
import { ensureBranchSnapshotId } from "lib/query/branches.queries";
import { ensureTestDetailData } from "lib/query/tests.queries";
import { trpc } from "lib/trpc";
import { Suspense } from "react";
import { useSelectedBranch } from "../-use-selected-branch";
import { AppLink } from "../../-app-link";
import { useCurrentApplication } from "../../-use-current-application";
import { useTestChanges } from "./-use-test-changes";

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

      <div className="px-11 pb-11 pt-8">
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

function TestDetailSkeleton() {
  return (
    <div className="p-11">
      <Skeleton className="mb-4 h-7 w-64" />
      <Skeleton className="mb-2 h-4 w-full max-w-xl" />
      <Skeleton className="mb-8 h-4 w-3/4 max-w-md" />
      <Skeleton className="h-64 w-full" />
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
