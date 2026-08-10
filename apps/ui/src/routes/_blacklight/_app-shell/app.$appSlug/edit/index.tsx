import { Badge, Button, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger } from "@autonoma/blacklight";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/MagnifyingGlass";
import { PencilSimpleIcon } from "@phosphor-icons/react/PencilSimple";
import { createFileRoute } from "@tanstack/react-router";
import { ensureBranchData } from "lib/query/branches.queries";
import { useEditSession, useEditSessionState, useStartEditSession } from "lib/query/snapshot-edit.queries";
import { Suspense } from "react";
import { useMainBranch } from "../-use-main-branch";
import { AppLink } from "../../-app-link";
import { EditChangesTab } from "./-changes/edit-changes-tab";
import { GenerationsTab } from "./-generations/generations-tab";
import { EditActionBar } from "./-test-suite/edit-action-bar";
import { TestSuiteTab } from "./-test-suite/test-suite-tab";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/edit/")({
  loader: async ({ context, params: { appSlug } }) => {
    const app = context.applications.find((a) => a.slug === appSlug);
    if (app == null) return;
    await ensureBranchData(context.queryClient, app.id, app.mainBranch.name);
  },
  component: EditPage,
});

// ─── Page Shell ──────────────────────────────────────────────────────────────

function EditPage() {
  const branch = useMainBranch();

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-start justify-between">
        <div>
          <div className="mb-2">
            <Button
              variant="ghost"
              size="xs"
              className="gap-1.5 text-text-tertiary"
              render={<AppLink to="/app/$appSlug/tests" />}
            >
              <ArrowLeftIcon size={12} />
              Back to tests
            </Button>
          </div>
          <h1 className="text-2xl font-medium tracking-tight text-text-primary">Edit Test Suite</h1>
          <p className="mt-1 font-mono text-xs text-text-secondary">
            Make changes to the test suite on branch {branch.name}
          </p>
        </div>
      </header>

      <Suspense fallback={<EditPageSkeleton />}>
        <EditSessionPanel branchId={branch.id} />
      </Suspense>
    </div>
  );
}

function EditPageSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-8 w-48" />
      <div className="flex gap-4">
        <Skeleton className="h-96 w-72 shrink-0" />
        <Skeleton className="h-96 flex-1" />
      </div>
    </div>
  );
}

/**
 * The branch's single pending-snapshot slot is shared with the analysis pipeline, so the editor renders from
 * whichever of the three states the slot is in - and never from "whatever snapshot happens to be pending".
 */
function EditSessionPanel({ branchId }: { branchId: string }) {
  const { data: session } = useEditSessionState(branchId);

  if (session.state === "analysis-in-flight") return <AnalysisInFlight />;
  if (session.state === "none") return <StartEditSession branchId={branchId} />;
  return <EditSessionContent snapshotId={session.snapshotId} />;
}

function StartEditSession({ branchId }: { branchId: string }) {
  const startEdit = useStartEditSession();

  return (
    <div className="flex flex-col items-center justify-center gap-4 py-16 text-text-secondary">
      <PencilSimpleIcon size={32} />
      <p className="text-sm">Start an editing session to modify the test suite</p>
      <Button onClick={() => startEdit.mutate({ branchId })} disabled={startEdit.isPending}>
        {startEdit.isPending ? "Starting..." : "Start editing"}
      </Button>
    </div>
  );
}

function AnalysisInFlight() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-16 text-text-secondary">
      <MagnifyingGlassIcon size={32} />
      <div className="flex flex-col items-center gap-1">
        <p className="text-sm">A new commit is being analyzed on this branch</p>
        <p className="text-2xs">The test suite cannot be edited until the analysis finishes.</p>
      </div>
      <Button variant="outline" size="sm" render={<AppLink to="/app/$appSlug/tests" />}>
        Back to tests
      </Button>
    </div>
  );
}

// ─── Edit Session Content ────────────────────────────────────────────────────

function EditSessionContent({ snapshotId }: { snapshotId: string }) {
  return (
    <Tabs defaultValue="test-suite" className="flex min-h-0 flex-1 flex-col">
      <TabsList className="shrink-0">
        <TabsTrigger value="test-suite">Test Suite</TabsTrigger>
        <GenerationsTrigger snapshotId={snapshotId} />
        <ChangesTrigger snapshotId={snapshotId} />
      </TabsList>

      <TabsContent value="test-suite" className="mt-4 min-h-0 flex-1">
        <TestSuiteTab snapshotId={snapshotId} />
      </TabsContent>

      <TabsContent value="generations" className="mt-4 min-h-0 flex-1">
        <GenerationsTab snapshotId={snapshotId} />
      </TabsContent>

      <TabsContent value="changes" className="mt-4 min-h-0 flex-1">
        <EditChangesTab snapshotId={snapshotId} />
      </TabsContent>

      <EditActionBar snapshotId={snapshotId} />
    </Tabs>
  );
}

function GenerationsTrigger({ snapshotId }: { snapshotId: string }) {
  const { data: session } = useEditSession(snapshotId);
  const awaitingCount = session.testsAwaitingRun.length;

  return (
    <TabsTrigger value="generations" className="gap-1.5">
      Generations
      {awaitingCount > 0 && (
        <Badge variant="secondary" className="ml-1 px-1.5 py-0 text-3xs">
          {awaitingCount}
        </Badge>
      )}
    </TabsTrigger>
  );
}

function ChangesTrigger({ snapshotId }: { snapshotId: string }) {
  const { data: session } = useEditSession(snapshotId);

  return (
    <TabsTrigger value="changes" className="gap-1.5">
      Changes
      {session.changes.length > 0 && (
        <Badge variant="secondary" className="ml-1 px-1.5 py-0 text-3xs">
          {session.changes.length}
        </Badge>
      )}
    </TabsTrigger>
  );
}
