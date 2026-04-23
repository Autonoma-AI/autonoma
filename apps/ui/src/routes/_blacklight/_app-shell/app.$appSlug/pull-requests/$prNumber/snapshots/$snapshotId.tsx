import { Badge, Panel, PanelBody, PanelHeader, PanelTitle, Skeleton } from "@autonoma/blacklight";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { CameraIcon } from "@phosphor-icons/react/Camera";
import { LightningIcon } from "@phosphor-icons/react/Lightning";
import { SwapIcon } from "@phosphor-icons/react/Swap";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { GenerationCard, type GenerationCardStatus } from "components/generation/generation-card";
import { ShaRange } from "components/snapshot/sha-range";
import { SnapshotChangeRow, type SnapshotChangeType } from "components/snapshot/snapshot-change-row";
import { formatDate } from "lib/format";
import { ensureSnapshotDetailData, useSnapshotDetail } from "lib/query/branches.queries";
import { Suspense } from "react";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";

export const Route = createFileRoute(
  "/_blacklight/_app-shell/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId",
)({
  loader: async ({ context, params: { appSlug, snapshotId } }) => {
    const app = context.applications.find((a) => a.slug === appSlug);
    if (app == null) throw notFound();
    await ensureSnapshotDetailData(context.queryClient, snapshotId);
  },
  component: SnapshotDetailPage,
});

function SnapshotDetailPage() {
  const { prNumber, snapshotId } = Route.useParams();

  return (
    <div className="flex flex-col gap-6">
      <Suspense fallback={<PageSkeleton prNumber={prNumber} />}>
        <SnapshotDetailContent prNumber={prNumber} snapshotId={snapshotId} />
      </Suspense>
    </div>
  );
}

function SnapshotDetailContent({ prNumber, snapshotId }: { prNumber: number; snapshotId: string }) {
  const { data } = useSnapshotDetail(snapshotId);
  const { snapshot, changes, generations } = data;

  return (
    <>
      <PageHeader prNumber={prNumber}>
        <div className="flex items-center gap-3">
          <ShaRange baseSha={snapshot.baseSha} headSha={snapshot.headSha} />
          <Badge variant={statusBadgeVariant(snapshot.status)}>{snapshot.status}</Badge>
          <span className="text-2xs text-text-tertiary">{formatDate(snapshot.createdAt)}</span>
        </div>
      </PageHeader>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,360px)]">
        <ChangesPanel changes={changes} />
        <GenerationsPanel generations={generations} />
      </div>
    </>
  );
}

function ChangesPanel({
  changes,
}: {
  changes: Array<{ type: SnapshotChangeType; testCaseId: string; testCaseName: string }>;
}) {
  return (
    <Panel>
      <PanelHeader className="flex items-center gap-2">
        <SwapIcon size={14} className="text-text-tertiary" />
        <PanelTitle>Changes</PanelTitle>
        <Badge variant="secondary" className="ml-1 px-1.5 py-0 text-3xs">
          {changes.length}
        </Badge>
      </PanelHeader>
      <PanelBody className="p-0">
        {changes.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-text-tertiary">
            <p className="text-sm">No changes in this snapshot</p>
          </div>
        ) : (
          <ul>
            {changes.map((change) => (
              <li key={change.testCaseId}>
                <SnapshotChangeRow type={change.type} testCaseName={change.testCaseName} />
              </li>
            ))}
          </ul>
        )}
      </PanelBody>
    </Panel>
  );
}

function GenerationsPanel({
  generations,
}: {
  generations: Array<{
    generationId: string;
    testCaseId: string;
    testCaseName: string;
    status: GenerationCardStatus;
  }>;
}) {
  return (
    <Panel>
      <PanelHeader className="flex items-center gap-2">
        <LightningIcon size={14} className="text-text-tertiary" />
        <PanelTitle>Generations</PanelTitle>
        <Badge variant="secondary" className="ml-1 px-1.5 py-0 text-3xs">
          {generations.length}
        </Badge>
      </PanelHeader>
      <PanelBody className="p-3">
        {generations.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-text-tertiary">
            <p className="text-sm">No generations yet</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {generations.map((g) => (
              <GenerationCard
                key={g.generationId}
                generationId={g.generationId}
                testCaseName={g.testCaseName}
                status={g.status}
              />
            ))}
          </div>
        )}
      </PanelBody>
    </Panel>
  );
}

function PageHeader({ prNumber, children }: { prNumber: number; children: React.ReactNode }) {
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
        <CameraIcon size={14} />
        <span className="font-mono text-2xs uppercase tracking-widest">Snapshot</span>
      </div>
      <h1 className="text-2xl font-medium tracking-tight text-text-primary">Snapshot detail</h1>
      {children}
    </header>
  );
}

function PageSkeleton({ prNumber }: { prNumber: number }) {
  return (
    <>
      <PageHeader prNumber={prNumber}>
        <Skeleton className="h-5 w-72" />
      </PageHeader>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,360px)]">
        <Panel>
          <PanelHeader>
            <PanelTitle>Changes</PanelTitle>
          </PanelHeader>
          <PanelBody className="p-4">
            <Skeleton className="h-32 w-full" />
          </PanelBody>
        </Panel>
        <Panel>
          <PanelHeader>
            <PanelTitle>Generations</PanelTitle>
          </PanelHeader>
          <PanelBody className="p-4">
            <Skeleton className="h-32 w-full" />
          </PanelBody>
        </Panel>
      </div>
    </>
  );
}

function statusBadgeVariant(status: string): "success" | "critical" | "outline" {
  switch (status) {
    case "active":
      return "success";
    case "failed":
      return "critical";
    default:
      return "outline";
  }
}
