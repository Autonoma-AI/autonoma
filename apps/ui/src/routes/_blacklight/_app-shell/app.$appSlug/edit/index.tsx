import { Badge, Button, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger } from "@autonoma/blacklight";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { PencilSimpleIcon } from "@phosphor-icons/react/PencilSimple";
import { createFileRoute } from "@tanstack/react-router";
import { ensureBranchData } from "lib/query/branches.queries";
import { useEditSession, useStartEditSession } from "lib/query/snapshot-edit.queries";
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
  const hasPendingSnapshot = branch.pendingSnapshotId != null;

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
        {hasPendingSnapshot ? <EditSessionContent branchId={branch.id} /> : <StartEditSession branchId={branch.id} />}
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

function StartEditSession({ branchId }: { branchId: string }) {
  const startEdit = useStartEditSession();

  return (
    <div className="flex flex-col items-center justify-center gap-4 py-16 text-text-tertiary">
      <PencilSimpleIcon size={32} />
      <p className="text-sm">Start an editing session to modify the test suite</p>
      <Button onClick={() => startEdit.mutate({ branchId })} disabled={startEdit.isPending}>
        {startEdit.isPending ? "Starting..." : "Start editing"}
      </Button>
    </div>
  );
}

// ─── Edit Session Content ────────────────────────────────────────────────────

function EditSessionContent({ branchId }: { branchId: string }) {
  return (
    <Tabs defaultValue="test-suite" className="flex min-h-0 flex-1 flex-col">
      <TabsList className="shrink-0">
        <TabsTrigger value="test-suite">Test Suite</TabsTrigger>
        <GenerationsTrigger branchId={branchId} />
        <ChangesTrigger branchId={branchId} />
      </TabsList>

      <TabsContent value="test-suite" className="mt-4 min-h-0 flex-1">
        <TestSuiteTab branchId={branchId} />
      </TabsContent>

      <TabsContent value="generations" className="mt-4 min-h-0 flex-1">
        <GenerationsTab branchId={branchId} />
      </TabsContent>

      <TabsContent value="changes" className="mt-4 min-h-0 flex-1">
        <EditChangesTab branchId={branchId} />
      </TabsContent>

      <EditActionBar branchId={branchId} />
    </Tabs>
  );
}

function GenerationsTrigger({ branchId }: { branchId: string }) {
  const { data: session } = useEditSession(branchId);
  const pendingCount = session.pendingGenerations.length;

  return (
    <TabsTrigger value="generations" className="gap-1.5">
      Generations
      {pendingCount > 0 && (
        <Badge variant="secondary" className="ml-1 px-1.5 py-0 text-3xs">
          {pendingCount}
        </Badge>
      )}
    </TabsTrigger>
  );
}

function ChangesTrigger({ branchId }: { branchId: string }) {
  const { data: session } = useEditSession(branchId);

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
