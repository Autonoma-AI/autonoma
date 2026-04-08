import { Badge, Button, Separator, Skeleton, stepInstruction as getStepInstruction } from "@autonoma/blacklight";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { Play } from "@phosphor-icons/react/Play";
import { StackIcon } from "@phosphor-icons/react/Stack";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { formatDate } from "lib/format";
import { ensureBranchSnapshotId } from "lib/query/branches.queries";
import { useRunTest } from "lib/query/runs.queries";
import { ensureTestDetailData, useRenameTest, useUpdateTestDescription } from "lib/query/tests.queries";
import { trpc } from "lib/trpc";
import { useMainBranch } from "../-use-main-branch";
import { AppLink } from "../../-app-link";
import { useAppNavigate } from "../../-use-app-navigate";
import { useCurrentApplication } from "../../-use-current-application";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/tests/$testSlug")({
  loader: async ({ context, params: { appSlug, testSlug } }) => {
    const app = context.applications.find((a: { slug: string }) => a.slug === appSlug);
    if (app == null) throw notFound();

    const snapshotId = await ensureBranchSnapshotId(context.queryClient, app.id, app.mainBranch.name);
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
      <TestDetailPanel key={testSlug} slug={testSlug} />
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-2xs font-semibold uppercase tracking-widest text-text-tertiary">{label}</span>
      <div className="text-sm text-text-secondary">{children}</div>
    </div>
  );
}

interface StepData {
  id: string;
  order: number;
  interaction: string;
  params: unknown;
  screenshotBefore: string | null | undefined;
  screenshotAfter: string | null | undefined;
}

function stepDescription(step: StepData): React.ReactNode {
  return getStepInstruction({ interaction: step.interaction, params: step.params });
}

function TestDetailPanel({ slug }: { slug: string }) {
  const currentApp = useCurrentApplication();
  const branch = useMainBranch();
  const snapshotId = branch.activeSnapshot.id;
  const navigate = useAppNavigate();

  const { data: test } = useSuspenseQuery(
    trpc.tests.detail.queryOptions({ applicationId: currentApp.id, slug, snapshotId }),
  );

  const _renameTest = useRenameTest();
  const _updateDescription = useUpdateTestDescription();
  const runTest = useRunTest();

  function handleRunTest() {
    runTest.mutate(
      { testCaseId: test.id },
      {
        onSuccess: ({ runId }) => {
          void navigate({
            to: "/app/$appSlug/runs/$runId",
            params: { runId },
          });
        },
      },
    );
  }

  return (
    <div className="p-6">
      <div className="mb-8 flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-medium tracking-tight text-text-primary">{test.name}</h1>
          {test.description != null && test.description.length > 0 && (
            <p className="mt-2 max-w-4xl text-sm leading-relaxed text-text-secondary">{test.description}</p>
          )}
        </div>
        {test.steps.length > 0 && (
          <Button
            size="sm"
            variant="default"
            onClick={handleRunTest}
            disabled={runTest.isPending}
            className="shrink-0"
            aria-label="trigger-test-run"
          >
            <Play size={14} />
            Run test
          </Button>
        )}
      </div>

      <div className="flex flex-col gap-6 lg:flex-row">
        <div className="w-full lg:w-72 lg:shrink-0">
          <div className="border border-border-mid bg-surface-raised p-5 lg:sticky lg:top-6">
            <div className="flex flex-col gap-5">
              <DetailRow label="Application">
                <span className="font-medium">{currentApp.name}</span>
              </DetailRow>

              {test.tags.length > 0 && (
                <>
                  <Separator />
                  <DetailRow label="Tags">
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      {test.tags.map((tag: string) => (
                        <Badge key={tag} variant="outline">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  </DetailRow>
                </>
              )}

              <Separator />

              <DetailRow label="Steps">
                <span className="font-medium">{test.steps.length}</span>
                <span className="ml-1 text-text-tertiary">{test.steps.length === 1 ? "step" : "steps"}</span>
              </DetailRow>

              <Separator />

              <DetailRow label="Created">
                <span>{formatDate(test.createdAt)}</span>
              </DetailRow>

              {test.generationId != null && (
                <>
                  <Separator />
                  <DetailRow label="Generation">
                    <Button
                      variant="link"
                      size="sm"
                      className="h-auto gap-1 p-0 font-mono text-2xs"
                      render={
                        <AppLink
                          to="/app/$appSlug/generations/$generationId"
                          params={{
                            generationId: test.generationId,
                          }}
                        />
                      }
                    >
                      View generation
                      <ArrowSquareOutIcon size={12} />
                    </Button>
                  </DetailRow>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          {test.steps.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 border border-dashed border-border-mid py-14 text-center">
              <StackIcon size={24} className="text-text-tertiary" />
              <p className="text-sm text-text-tertiary">No steps defined</p>
            </div>
          ) : (
            <div>
              {test.steps.map((step: StepData, i: number) => {
                const screenshot = step.screenshotBefore ?? step.screenshotAfter;
                const instruction = stepDescription(step);
                const isLast = i === test.steps.length - 1;

                return (
                  <div key={step.id} className="flex gap-4">
                    <div className="mt-0.5 flex flex-col items-center">
                      <div className="flex size-6 shrink-0 items-center justify-center border border-border-mid bg-surface-base">
                        <span className="font-mono text-3xs text-text-tertiary">{step.order}</span>
                      </div>
                      {!isLast && <div className="mt-1 h-full w-px bg-border-mid" />}
                    </div>

                    <div className="mb-3 flex-1 overflow-hidden border border-border-mid bg-surface-raised">
                      <div className="flex">
                        {screenshot != null && (
                          <div className="relative w-52 shrink-0 overflow-hidden border-r border-border-mid bg-surface-base">
                            <img src={screenshot} alt={`Step ${step.order}`} className="h-full w-full object-cover" />
                          </div>
                        )}
                        <div className="flex flex-1 flex-col justify-center gap-2 px-4 py-3">
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-sm font-medium leading-snug text-text-primary">{instruction}</p>
                            <span className="shrink-0 font-mono text-2xs font-medium text-text-tertiary">
                              #{step.order}
                            </span>
                          </div>
                          <Badge variant="outline" className="w-fit font-mono text-3xs uppercase">
                            {step.interaction}
                          </Badge>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TestDetailSkeleton() {
  return (
    <div className="p-6">
      <Skeleton className="mb-3 h-9 w-64" />
      <Skeleton className="mb-1 h-4 w-full max-w-xl" />
      <Skeleton className="mb-8 h-4 w-3/4 max-w-md" />
      <div className="flex flex-col gap-6 lg:flex-row">
        <div className="flex w-full flex-col gap-4 lg:w-72 lg:shrink-0">
          <Skeleton className="h-48 w-full" />
        </div>
        <div className="flex flex-1 flex-col gap-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      </div>
    </div>
  );
}

function NotFoundTest() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <p className="text-sm font-medium text-text-primary">Test not found</p>
      <p className="text-sm text-text-secondary">This test may have been deleted or the slug is incorrect.</p>
    </div>
  );
}
