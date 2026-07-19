import {
  Badge,
  Button,
  Dialog,
  DialogBackdrop,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Skeleton,
  StatusDot,
  cn,
} from "@autonoma/blacklight";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react/ArrowCounterClockwise";
import { ClockCounterClockwiseIcon } from "@phosphor-icons/react/ClockCounterClockwise";
import { QueryErrorResetBoundary } from "@tanstack/react-query";
import { useDeploymentHistory } from "lib/query/deployments.queries";
import type { RouterOutputs } from "lib/trpc";
import { Component, type ReactNode, Suspense, useState } from "react";
import { DEPLOYMENT_STATUS_META, DeploymentRow, type DeploymentHistoryRow } from "./deployment-row";
import { TestUserCard, TestUserCardSkeleton, TestUserCardUnavailable } from "./test-user-card";

type PreviewSummary = RouterOutputs["deployments"]["previewSummaryById"];

/**
 * Environment-level summary strip shown once above the resource rail + logs: the current deployment
 * (sha, status, age, duration, history) and the test user (status + provision action). Both are
 * environment-scoped, not per-app - unlike the legacy explorer body, neither changes when the reader
 * selects a different app/service in the rail.
 */
export function EnvironmentSummaryStrip({
  applicationId,
  environmentId,
  summary,
}: {
  applicationId: string;
  environmentId: string;
  summary: PreviewSummary;
}) {
  const environmentActive = summary.status === "building" || summary.phase === "deploy_requested";

  return (
    <div className="flex flex-wrap items-stretch divide-y divide-border-dim border border-border-dim bg-surface-base sm:flex-nowrap sm:divide-x sm:divide-y-0">
      <QueryErrorResetBoundary>
        {({ reset }) => (
          <DeploymentSummaryErrorBoundary onRetry={reset}>
            <Suspense fallback={<DeploymentSummarySkeleton />}>
              <DeploymentSummary
                applicationId={applicationId}
                environmentId={environmentId}
                environmentActive={environmentActive}
              />
            </Suspense>
          </DeploymentSummaryErrorBoundary>
        )}
      </QueryErrorResetBoundary>
      {summary.status === "ready" ? (
        <Suspense fallback={<TestUserCardSkeleton compact />}>
          <TestUserCard applicationId={applicationId} environmentId={environmentId} compact />
        </Suspense>
      ) : (
        <TestUserCardUnavailable status={summary.status} compact />
      )}
    </div>
  );
}

// The current deployment's summary, plus a "History" button opening the full list (reusing
// DeploymentRow, unchanged) in a Dialog rather than an always-visible docked rail.
function DeploymentSummary({
  applicationId,
  environmentId,
  environmentActive,
}: {
  applicationId: string;
  environmentId: string;
  environmentActive: boolean;
}) {
  const { data: deployments } = useDeploymentHistory(applicationId, environmentId, {
    pollWhileActive: environmentActive,
  });
  const [historyOpen, setHistoryOpen] = useState(false);
  const current = deployments.find((deployment) => deployment.isCurrent) ?? deployments[0];

  return (
    <div className="flex flex-1 flex-wrap items-center gap-3 px-4 py-3">
      <span className="size-1.5 shrink-0 bg-primary" />
      <span className="font-mono text-2xs font-bold uppercase tracking-wider text-text-primary">Deployment</span>
      {current == null ? (
        <span className="text-2xs text-text-secondary">No deployments yet.</span>
      ) : (
        <DeploymentSummaryDetail deployment={current} />
      )}
      <Button
        variant="outline"
        size="xs"
        className="ml-auto gap-1.5"
        disabled={deployments.length === 0}
        onClick={() => setHistoryOpen(true)}
      >
        <ClockCounterClockwiseIcon size={13} />
        History · {deployments.length}
      </Button>
      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogBackdrop />
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Deployment history</DialogTitle>
          </DialogHeader>
          <DialogBody className="max-h-96 divide-y divide-border-dim overflow-y-auto p-0">
            {deployments.map((deployment) => (
              <DeploymentRow key={deployment.id} deployment={deployment} />
            ))}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DeploymentSummaryDetail({ deployment }: { deployment: DeploymentHistoryRow }) {
  const statusMeta = DEPLOYMENT_STATUS_META[deployment.status];

  return (
    <>
      <StatusDot status={statusMeta.dot} className="shrink-0 rounded-full" />
      <span className="font-mono text-sm text-text-primary">{deployment.headSha.slice(0, 7)}</span>
      <Badge variant={statusMeta.badge} className={cn("shrink-0 uppercase", statusMeta.className)}>
        {statusMeta.label}
      </Badge>
    </>
  );
}

function DeploymentSummarySkeleton() {
  return (
    <div className="flex flex-1 items-center gap-4 px-4 py-3">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-4 flex-1" />
      <Skeleton className="h-7 w-28" />
    </div>
  );
}

// Isolates a failed `deployments.history` fetch (thrown by useSuspenseQuery) to this half of the
// strip. Retry clears the local error and resets the query cache (via onRetry) so the child refetches.
class DeploymentSummaryErrorBoundary extends Component<
  { children: ReactNode; onRetry: () => void },
  { hasError: boolean }
> {
  override state: { hasError: boolean } = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  override render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="flex flex-1 items-center gap-3 px-4 py-3 text-sm text-text-secondary">
        <span>Couldn't load deployment status.</span>
        <Button
          variant="outline"
          size="xs"
          className="gap-1.5"
          onClick={() => {
            this.setState({ hasError: false });
            this.props.onRetry();
          }}
        >
          <ArrowCounterClockwiseIcon size={12} />
          Retry
        </Button>
      </div>
    );
  }
}

/** Skeleton mirroring EnvironmentSummaryStrip's layout, for the redesigned Preview tab's initial load. */
export function EnvironmentSummaryStripSkeleton() {
  return (
    <div className="flex flex-wrap items-stretch divide-y divide-border-dim border border-border-dim bg-surface-base sm:flex-nowrap sm:divide-x sm:divide-y-0">
      <DeploymentSummarySkeleton />
      <TestUserCardSkeleton compact />
    </div>
  );
}
