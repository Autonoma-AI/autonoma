import { Badge, Panel, PanelBody, PanelHeader, PanelTitle, Skeleton } from "@autonoma/blacklight";
import { RocketLaunchIcon } from "@phosphor-icons/react/RocketLaunch";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { formatDate } from "lib/format";
import { ensureAPIQueryData } from "lib/query/api-queries";
import { trpc } from "lib/trpc";
import { useState } from "react";
import { useCurrentApplication } from "../../-use-current-application";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/deployments/")({
  loader: ({ context, params: { appSlug } }) => {
    const app = context.applications.find((a) => a.slug === appSlug);
    if (app == null) return;
    return ensureAPIQueryData(
      context.queryClient,
      trpc.github.deploymentsDebug.queryOptions({ applicationId: app.id }, { staleTime: Infinity }),
    );
  },
  component: DeploymentsPage,
  pendingComponent: TableSkeleton,
});

const TH = "px-4 py-2.5 text-left font-mono text-2xs font-medium uppercase tracking-widest text-text-tertiary";

type SnapshotStatus = "processing" | "active" | "superseded" | "failed";
type SnapshotSource = "GITHUB_PUSH" | "MANUAL" | "WEBHOOK";

function snapshotStatusVariant(status: SnapshotStatus) {
  switch (status) {
    case "active":
      return "status-passed";
    case "processing":
      return "status-running";
    case "failed":
      return "status-failed";
    case "superseded":
      return "status-pending";
  }
}

function sha(value: string | null | undefined) {
  if (value == null) return "-";
  return value.slice(0, 7);
}

function DeploymentsPage() {
  const app = useCurrentApplication();
  const { data } = useSuspenseQuery(
    trpc.github.deploymentsDebug.queryOptions(
      { applicationId: app.id },
      { staleTime: Infinity, refetchInterval: 10_000 },
    ),
  );

  const { repository, pullRequests, branches } = data;

  // Build a map of githubRef/name -> branch for cross-referencing
  const branchByRef = new Map<string, (typeof branches)[number]>();
  for (const branch of branches) {
    if (branch.githubRef != null) branchByRef.set(branch.githubRef, branch);
    branchByRef.set(branch.name, branch);
  }

  // Match PRs to branches
  const matchedPRs = pullRequests.map((pr) => ({
    pr,
    branch: branchByRef.get(pr.headRef),
  }));

  // Find branches with no matching PR
  const prRefs = new Set(pullRequests.map((pr) => pr.headRef));
  const unmatchedBranches = branches.filter((b) => !prRefs.has(b.githubRef ?? "") && !prRefs.has(b.name));

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-medium tracking-tight text-text-primary">Deployments (Debug)</h1>
        <p className="mt-1 font-mono text-xs text-text-secondary">
          {repository != null ? (
            <span>
              Repo:{" "}
              <a
                href={`https://github.com/${repository}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary-ink hover:underline"
              >
                {repository}
              </a>
              {" - "}
            </span>
          ) : null}
          Open PRs cross-referenced with branch deployments and snapshots
        </p>
      </header>

      <Panel>
        <PanelHeader className="flex items-center gap-2">
          <RocketLaunchIcon size={14} className="text-text-tertiary" />
          <PanelTitle>Pull Requests & Branches</PanelTitle>
          <span className="ml-auto font-mono text-2xs text-text-tertiary">
            {pullRequests.length} PRs - {branches.length} branches
          </span>
        </PanelHeader>
        <PanelBody className="overflow-auto p-0">
          <table className="w-full">
            <thead className="sticky top-0 z-10 bg-surface-base">
              <tr className="border-b border-border-dim">
                <th className={TH}>PR</th>
                <th className={TH}>Branch</th>
                <th className={TH}>Head SHA</th>
                <th className={TH}>Deployment</th>
                <th className={TH}>Latest Snapshot</th>
                <th className={TH}>Created</th>
              </tr>
            </thead>
            <tbody>
              {matchedPRs.map(({ pr, branch }) => (
                <PRRow key={pr.number} pr={pr} branch={branch} />
              ))}
              {unmatchedBranches.map((branch) => (
                <BranchOnlyRow key={branch.id} branch={branch} />
              ))}
              {matchedPRs.length === 0 && unmatchedBranches.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-xs text-text-tertiary">
                    No pull requests or branches found
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </PanelBody>
      </Panel>
    </div>
  );
}

interface PRRowProps {
  pr: {
    number: number;
    title: string;
    headRef: string;
    headSha: string;
    url: string;
    createdAt: string;
  };
  branch?: {
    id: string;
    name: string;
    githubRef: string | null;
    lastHandledSha: string | null;
    deployment: {
      id: string;
      active: boolean;
      webhookUrl: string | null;
      createdAt: Date;
      webDeployment: { url: string } | null;
      mobileDeployment: { packageName: string } | null;
    } | null;
    snapshots: Array<{
      id: string;
      status: SnapshotStatus;
      source: SnapshotSource;
      headSha: string | null;
      baseSha: string | null;
      createdAt: Date;
      _count: { testGenerations: number; testCaseAssignments: number };
    }>;
  };
}

function PRRow({ pr, branch }: PRRowProps) {
  const [expanded, setExpanded] = useState(false);
  const latestSnapshot = branch?.snapshots[0];

  return (
    <>
      <tr
        className="border-b border-border-dim transition-colors hover:bg-surface-raised cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <td className="px-4 py-2.5">
          <a
            href={pr.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-medium text-primary-ink hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            #{pr.number}
          </a>
          <span className="ml-2 text-xs text-text-secondary">{pr.title.slice(0, 40)}</span>
        </td>
        <td className="px-4 py-2.5">
          {branch != null ? (
            <span className="font-mono text-2xs text-text-primary">{branch.name}</span>
          ) : (
            <span className="font-mono text-2xs text-text-tertiary">no branch</span>
          )}
        </td>
        <td className="px-4 py-2.5 font-mono text-2xs text-text-secondary">{sha(pr.headSha)}</td>
        <td className="px-4 py-2.5">
          <DeploymentCell deployment={branch?.deployment} />
        </td>
        <td className="px-4 py-2.5">
          <SnapshotCell snapshot={latestSnapshot} />
        </td>
        <td className="px-4 py-2.5 font-mono text-2xs text-text-tertiary">{formatDate(new Date(pr.createdAt))}</td>
      </tr>
      {expanded && branch != null && branch.snapshots.length > 0 && (
        <tr className="border-b border-border-dim">
          <td colSpan={6} className="bg-surface-raised/50 px-4 py-3">
            <SnapshotsDetail snapshots={branch.snapshots} />
          </td>
        </tr>
      )}
    </>
  );
}

function BranchOnlyRow({ branch }: { branch: PRRowProps["branch"] & {} }) {
  const [expanded, setExpanded] = useState(false);
  const latestSnapshot = branch.snapshots[0];

  return (
    <>
      <tr
        className="border-b border-border-dim transition-colors hover:bg-surface-raised cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <td className="px-4 py-2.5 text-xs text-text-tertiary">-</td>
        <td className="px-4 py-2.5">
          <span className="font-mono text-2xs text-text-primary">{branch.name}</span>
          {branch.githubRef != null && branch.githubRef !== branch.name && (
            <span className="ml-1 font-mono text-2xs text-text-tertiary">({branch.githubRef})</span>
          )}
        </td>
        <td className="px-4 py-2.5 font-mono text-2xs text-text-secondary">{sha(branch.lastHandledSha)}</td>
        <td className="px-4 py-2.5">
          <DeploymentCell deployment={branch.deployment} />
        </td>
        <td className="px-4 py-2.5">
          <SnapshotCell snapshot={latestSnapshot} />
        </td>
        <td className="px-4 py-2.5" />
      </tr>
      {expanded && branch.snapshots.length > 0 && (
        <tr className="border-b border-border-dim">
          <td colSpan={6} className="bg-surface-raised/50 px-4 py-3">
            <SnapshotsDetail snapshots={branch.snapshots} />
          </td>
        </tr>
      )}
    </>
  );
}

function DeploymentCell({ deployment }: { deployment: NonNullable<PRRowProps["branch"]>["deployment"] | undefined }) {
  if (deployment == null) {
    return <span className="text-2xs text-text-tertiary">none</span>;
  }
  return (
    <div className="flex items-center gap-1.5">
      <Badge variant={deployment.active ? "success" : "secondary"}>{deployment.active ? "active" : "inactive"}</Badge>
      {deployment.webDeployment != null && (
        <span className="font-mono text-2xs text-text-tertiary" title={deployment.webDeployment.url}>
          web
        </span>
      )}
      {deployment.mobileDeployment != null && <span className="font-mono text-2xs text-text-tertiary">mobile</span>}
    </div>
  );
}

function SnapshotCell({
  snapshot,
}: {
  snapshot?: {
    status: SnapshotStatus;
    source: SnapshotSource;
    _count: { testGenerations: number; testCaseAssignments: number };
  };
}) {
  if (snapshot == null) {
    return <span className="text-2xs text-text-tertiary">none</span>;
  }
  return (
    <div className="flex items-center gap-1.5">
      <Badge variant={snapshotStatusVariant(snapshot.status)}>{snapshot.status}</Badge>
      <span className="font-mono text-2xs text-text-tertiary">{snapshot.source}</span>
      <span className="font-mono text-2xs text-text-tertiary">
        {snapshot._count.testGenerations}g / {snapshot._count.testCaseAssignments}t
      </span>
    </div>
  );
}

function SnapshotsDetail({
  snapshots,
}: {
  snapshots: Array<{
    id: string;
    status: SnapshotStatus;
    source: SnapshotSource;
    headSha: string | null;
    baseSha: string | null;
    createdAt: Date;
    _count: { testGenerations: number; testCaseAssignments: number };
  }>;
}) {
  return (
    <div>
      <p className="mb-2 font-mono text-2xs font-medium uppercase tracking-widest text-text-tertiary">
        Snapshots ({snapshots.length})
      </p>
      <table className="w-full">
        <thead>
          <tr className="text-left">
            <th className="pb-1 pr-4 font-mono text-2xs font-medium text-text-tertiary">Status</th>
            <th className="pb-1 pr-4 font-mono text-2xs font-medium text-text-tertiary">Source</th>
            <th className="pb-1 pr-4 font-mono text-2xs font-medium text-text-tertiary">Head</th>
            <th className="pb-1 pr-4 font-mono text-2xs font-medium text-text-tertiary">Base</th>
            <th className="pb-1 pr-4 font-mono text-2xs font-medium text-text-tertiary">Gens</th>
            <th className="pb-1 pr-4 font-mono text-2xs font-medium text-text-tertiary">Tests</th>
            <th className="pb-1 font-mono text-2xs font-medium text-text-tertiary">Created</th>
          </tr>
        </thead>
        <tbody>
          {snapshots.map((snap) => (
            <tr key={snap.id} className="text-xs">
              <td className="pr-4 py-0.5">
                <Badge variant={snapshotStatusVariant(snap.status)}>{snap.status}</Badge>
              </td>
              <td className="pr-4 py-0.5 font-mono text-2xs text-text-secondary">{snap.source}</td>
              <td className="pr-4 py-0.5 font-mono text-2xs text-text-secondary">{sha(snap.headSha)}</td>
              <td className="pr-4 py-0.5 font-mono text-2xs text-text-secondary">{sha(snap.baseSha)}</td>
              <td className="pr-4 py-0.5 font-mono text-2xs text-text-secondary">{snap._count.testGenerations}</td>
              <td className="pr-4 py-0.5 font-mono text-2xs text-text-secondary">{snap._count.testCaseAssignments}</td>
              <td className="py-0.5 font-mono text-2xs text-text-tertiary">{formatDate(new Date(snap.createdAt))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="mt-2 h-4 w-72" />
      </div>
      <Panel>
        <PanelHeader>
          <Skeleton className="h-4 w-32" />
        </PanelHeader>
        <PanelBody className="p-4">
          <div className="flex flex-col gap-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        </PanelBody>
      </Panel>
    </div>
  );
}
