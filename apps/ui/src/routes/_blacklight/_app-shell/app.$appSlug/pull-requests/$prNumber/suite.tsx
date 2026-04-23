import { Skeleton } from "@autonoma/blacklight";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { ListChecksIcon } from "@phosphor-icons/react/ListChecks";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { ReadOnlyTestDetail, ReadOnlyTestDetailEmpty } from "components/test/read-only-test-detail";
import {
  ensureActiveSnapshotData,
  ensureBranchByPrData,
  useActiveSnapshot,
  useBranchByPr,
} from "lib/query/branches.queries";
import type { RouterOutputs } from "lib/trpc";
import { Suspense, useState } from "react";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";
import { useCurrentApplication } from "routes/_blacklight/_app-shell/-use-current-application";
import { EditTab } from "../../edit/-edit-tab-content";
import { EditTreePanel } from "../../edit/-test-suite/edit-tree";
import type { TestCaseRecord } from "../../tests/-tests-tree/tree-types";

type ActiveSnapshot = RouterOutputs["branches"]["activeSnapshot"];
type TestCaseEntry = ActiveSnapshot["testSuite"]["testCases"][number];
type SnapshotChange = ActiveSnapshot["changes"][number];

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/pull-requests/$prNumber/suite")({
  loader: async ({ context, params: { appSlug, prNumber } }) => {
    const app = context.applications.find((a) => a.slug === appSlug);
    if (app == null) throw notFound();
    const branch = await ensureBranchByPrData(context.queryClient, app.id, prNumber);
    await ensureActiveSnapshotData(context.queryClient, branch.id);
  },
  component: ActiveSuitePage,
});

function ActiveSuitePage() {
  const { prNumber } = Route.useParams();

  return (
    <div className="flex flex-col gap-6">
      <Suspense fallback={<PageSkeleton prNumber={prNumber} />}>
        <ActiveSuiteContent prNumber={prNumber} />
      </Suspense>
    </div>
  );
}

function ActiveSuiteContent({ prNumber }: { prNumber: number }) {
  const app = useCurrentApplication();
  const { data: branch } = useBranchByPr(app.id, prNumber);
  const { data: active } = useActiveSnapshot(branch.id);

  const [selectedTestId, setSelectedTestId] = useState<string | undefined>();

  const changesByTestCaseId = new Map(active.changes.map((c) => [c.testCaseId, c.type] as const));
  const removedChangesByTestCaseId = new Map(
    active.changes.filter((c) => c.type === "removed").map((c) => [c.testCaseId, c] as const),
  );

  const testCasesForTree = buildTestCaseList(active.testSuite.testCases, active.changes);
  const selected = resolveSelectedTest(selectedTestId, active.testSuite.testCases, removedChangesByTestCaseId);

  return (
    <>
      <PageHeader prNumber={prNumber} />

      <EditTab>
        <div className="w-72">
          <div className="h-full border border-border-mid bg-surface-raised">
            <EditTreePanel
              testCases={testCasesForTree}
              selectedTestId={selectedTestId}
              onSelectTest={setSelectedTestId}
              changesByTestCaseId={changesByTestCaseId}
            />
          </div>
        </div>

        <div className="min-w-0 flex-1 border border-border-mid bg-surface-raised">
          {selected != null ? (
            <ReadOnlyTestDetail key={selected.testCase.name} testCase={selected.testCase} />
          ) : (
            <ReadOnlyTestDetailEmpty />
          )}
        </div>
      </EditTab>
    </>
  );
}

function buildTestCaseList(testCases: TestCaseEntry[], changes: SnapshotChange[]): TestCaseRecord[] {
  const records: TestCaseRecord[] = testCases.map((tc) => ({
    id: tc.id,
    name: tc.name,
    slug: tc.slug,
    folderId: tc.folderId,
  }));

  for (const change of changes) {
    if (change.type !== "removed") continue;
    records.push({
      id: change.testCaseId,
      name: change.testCaseName,
      slug: change.testCaseSlug,
      folderId: change.testCaseFolderId,
    });
  }

  return records;
}

interface ResolvedSelection {
  testCase: {
    name: string;
    plan: { prompt: string } | null;
    steps: { list: unknown } | null;
  };
}

function resolveSelectedTest(
  selectedTestId: string | undefined,
  testCases: TestCaseEntry[],
  removed: Map<string, Extract<SnapshotChange, { type: "removed" }>>,
): ResolvedSelection | undefined {
  if (selectedTestId == null) return undefined;

  const active = testCases.find((tc) => tc.id === selectedTestId);
  if (active != null) {
    return {
      testCase: {
        name: active.name,
        plan: active.plan != null ? { prompt: active.plan.prompt } : null,
        steps: active.steps,
      },
    };
  }

  const removedEntry = removed.get(selectedTestId);
  if (removedEntry != null) {
    return {
      testCase: {
        name: removedEntry.testCaseName,
        plan: { prompt: removedEntry.previousPlan },
        steps: null,
      },
    };
  }

  return undefined;
}

function PageHeader({ prNumber }: { prNumber: number }) {
  return (
    <header className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-text-tertiary">
        <AppLink
          to="/app/$appSlug/pull-requests/$prNumber"
          params={{ prNumber }}
          aria-label="Back to pull request"
          className="inline-flex size-5 shrink-0 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-surface-raised hover:text-text-primary"
        >
          <ArrowLeftIcon size={12} />
        </AppLink>
        <ListChecksIcon size={14} />
        <span className="font-mono text-2xs uppercase tracking-widest">Active suite</span>
        <span className="font-mono text-2xs">#{prNumber}</span>
      </div>
      <h1 className="text-2xl font-medium tracking-tight text-text-primary">Active test suite</h1>
    </header>
  );
}

function PageSkeleton({ prNumber }: { prNumber: number }) {
  return (
    <>
      <PageHeader prNumber={prNumber} />
      <EditTab>
        <div className="w-72">
          <Skeleton className="h-full w-full" />
        </div>
        <div className="min-w-0 flex-1">
          <Skeleton className="h-full w-full" />
        </div>
      </EditTab>
    </>
  );
}
