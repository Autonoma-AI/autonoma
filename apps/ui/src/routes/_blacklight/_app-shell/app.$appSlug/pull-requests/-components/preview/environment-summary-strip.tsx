import {
  Button,
  Dialog,
  DialogBackdrop,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Skeleton,
  buttonVariants,
  cn,
} from "@autonoma/blacklight";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react/ArrowCounterClockwise";
import { ClockCounterClockwiseIcon } from "@phosphor-icons/react/ClockCounterClockwise";
import { GearSixIcon } from "@phosphor-icons/react/GearSix";
import { QueryErrorResetBoundary } from "@tanstack/react-query";
import { PreviewLivenessBadge } from "components/preview-liveness-badge";
import { PREVIEW_STATUS_HELP, PreviewStatusBadge } from "components/preview-status-badge";
import { useDeploymentHistory } from "lib/query/deployments.queries";
import {
  pickPreviewLiveness,
  type PreviewLivenessState,
  useApplicationPreviewLiveness,
} from "lib/query/preview-access.queries";
import type { RouterOutputs } from "lib/trpc";
import { Component, type ReactNode, Suspense, useState } from "react";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";
import { DEPLOYMENT_STATUS_META, DeploymentRow, type DeploymentHistoryRow } from "./deployment-row";

type PreviewSummary = RouterOutputs["deployments"]["previewSummaryById"];

/** The strip's trailing cell, sharing DeploymentSummary's vertical padding so the two rows align. */
const TRAILING_CELL_CLASS = "flex shrink-0 items-center py-3 pr-4";

/**
 * Environment-level summary strip shown once above the resource rail + logs: the current deployment's
 * sha, status, age, duration and history. Environment-scoped, not per-app - unlike the explorer body,
 * it doesn't change when the reader selects a different app/service in the rail.
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

  // Every managed service in a preview sleeps and wakes together, so one runtime
  // state covers the whole environment. Query on the services' URLs; non-preview
  // or unresolved ones fall through to "unknown" (no badge).
  const livenessUrls = summary.services.map((service) => service.endpoint).filter((url): url is string => url != null);
  const { data: liveness } = useApplicationPreviewLiveness();
  const livenessState = pickPreviewLiveness(liveness, livenessUrls);

  return (
    <div className="flex items-stretch border border-border-dim bg-surface-base">
      <QueryErrorResetBoundary>
        {({ reset }) => (
          <DeploymentSummaryErrorBoundary onRetry={reset}>
            <Suspense fallback={<DeploymentSummarySkeleton />}>
              <DeploymentSummary
                applicationId={applicationId}
                environmentId={environmentId}
                environmentActive={environmentActive}
                livenessState={livenessState}
              />
            </Suspense>
          </DeploymentSummaryErrorBoundary>
        )}
      </QueryErrorResetBoundary>
      <PreviewSettingsLink />
    </div>
  );
}

/**
 * Sits beside the deployment summary rather than inside it because it needs none of its data, so it
 * survives the summary's loading and error states - a failed deploy fetch is when the config is most
 * wanted. Environment-scoped, unlike the rail's Rebuild/Restart, which act on the selected service.
 */
function PreviewSettingsLink() {
  return (
    <div className={TRAILING_CELL_CLASS}>
      {/* The label needs no "Preview" qualifier on a screen that is already the preview, but the shell's
          global Settings link is on the same page - so the accessible name keeps the distinction. */}
      <AppLink
        to="/app/$appSlug/preview-config"
        aria-label="Preview settings"
        className={cn(buttonVariants({ variant: "outline", size: "xs" }), "gap-1.5")}
      >
        <GearSixIcon size={13} />
        Settings
      </AppLink>
    </div>
  );
}

// The current deployment's summary, plus a "History" button opening the full list (reusing
// DeploymentRow, unchanged) in a Dialog rather than an always-visible docked rail.
function DeploymentSummary({
  applicationId,
  environmentId,
  environmentActive,
  livenessState,
}: {
  applicationId: string;
  environmentId: string;
  environmentActive: boolean;
  livenessState: PreviewLivenessState;
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
        <DeploymentSummaryDetail deployment={current} livenessState={livenessState} />
      )}
      {/* The honest "is it up right now" signal, distinct from the deploy status:
          a successful deploy that has since scaled to zero reads "Idle", not "Ready". */}
      <PreviewLivenessBadge state={livenessState} />
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

function DeploymentSummaryDetail({
  deployment,
  livenessState,
}: {
  deployment: DeploymentHistoryRow;
  livenessState: PreviewLivenessState;
}) {
  const statusMeta = DEPLOYMENT_STATUS_META[deployment.status];
  // A green "Success" here would just duplicate the runtime badge (Live/Idle)
  // beside it - but only when we actually have a runtime signal. If liveness is
  // unknown the runtime badge renders nothing, so the deploy status is the only
  // thing we can show and suppressing it would leave the strip with just the sha.
  const runtimeBadgeCovers = deployment.status === "success" && livenessState !== "unknown";

  return (
    <>
      <span className="font-mono text-sm text-text-primary">{deployment.headSha.slice(0, 7)}</span>
      {!runtimeBadgeCovers && (
        <PreviewStatusBadge
          label={statusMeta.label}
          variant={statusMeta.badge}
          help={PREVIEW_STATUS_HELP[statusMeta.label]}
          className={statusMeta.className}
        />
      )}
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
    <div className="flex items-stretch border border-border-dim bg-surface-base">
      <DeploymentSummarySkeleton />
      <div className={TRAILING_CELL_CLASS}>
        <Skeleton className="h-6 w-24" />
      </div>
    </div>
  );
}
