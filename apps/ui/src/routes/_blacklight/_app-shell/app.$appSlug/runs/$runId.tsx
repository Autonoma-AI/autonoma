import {
  Badge,
  BrailleSpinner,
  Button,
  Panel,
  PanelBody,
  Separator,
  Skeleton,
  getStepOverlayPoints,
  stepInstruction,
} from "@autonoma/blacklight";
import { ArrowLeft } from "@phosphor-icons/react/ArrowLeft";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react/ArrowsClockwise";
import { CaretRight } from "@phosphor-icons/react/CaretRight";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { LightbulbIcon } from "@phosphor-icons/react/Lightbulb";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/MagnifyingGlass";
import { Stack } from "@phosphor-icons/react/Stack";
import { Trash } from "@phosphor-icons/react/Trash";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { createFileRoute } from "@tanstack/react-router";
import { Sentry } from "components/icons/sentry";
import { Temporal } from "components/icons/temporal";
import { NavigableLightbox, type NavigableStep } from "components/screenshot-lightbox";
import { env } from "env";
import { useAuth } from "lib/auth";
import { formatDate } from "lib/format";
import { useRequestRunReview } from "lib/query/issues.queries";
import { ensureRunDetailData, useRestartRun, useRunDetail } from "lib/query/runs.queries";
import { useState } from "react";
import { AppLink } from "../../-app-link";
import { useAppNavigate } from "../../-use-app-navigate";
import { useCurrentApplication } from "../../-use-current-application";
import { DeleteRunDialog } from "./-delete-run-dialog";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/runs/$runId")({
  loader: async ({ context: { queryClient }, params: { runId } }) => {
    await ensureRunDetailData(queryClient, runId);
  },
  pendingComponent: RunDetailSkeleton,
  notFoundComponent: NotFoundRun,
  component: RunDetailPage,
});

type RunStatus = "pending" | "running" | "success" | "failed";

interface RunStep {
  id: string;
  order: number;
  interaction: string;
  params: unknown;
  output: object;
  screenshotBefore: string | null;
  screenshotAfter: string | null;
}

function toRunBadgeVariant(status: RunStatus) {
  switch (status) {
    case "success":
      return "success" as const;
    case "failed":
      return "critical" as const;
    case "running":
      return "status-running" as const;
    case "pending":
      return "status-pending" as const;
  }
}

function toRunStatusLabel(status: RunStatus) {
  switch (status) {
    case "success":
      return "Passed";
    case "failed":
      return "Failed";
    case "running":
      return "Running";
    case "pending":
      return "Pending";
  }
}

function RunDetailPage() {
  const { runId } = Route.useParams();
  const currentApp = useCurrentApplication();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const navigate = useAppNavigate();

  const { data: run } = useRunDetail(runId, { refetchInterval: computeRefetchInterval });
  const [lightboxIndex, setLightboxIndex] = useState<number | undefined>(undefined);

  const restartRun = useRestartRun(runId);
  const requestReview = useRequestRunReview();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  if (run == null) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
        <p className="text-sm font-medium text-text-primary">Run not found</p>
        <p className="text-sm text-text-secondary">This run may have been deleted.</p>
      </div>
    );
  }

  const status = run.status as RunStatus;
  const steps = run.steps as unknown as RunStep[];
  const review = run.review;
  const reviewStatus = review?.status;
  const temporalBaseUrl = env.VITE_TEMPORAL_URL?.replace(/\/$/, "");

  const temporalUrl =
    temporalBaseUrl != null && run.temporalWorkflow != null
      ? `${temporalBaseUrl}/namespaces/${env.VITE_TEMPORAL_NAMESPACE}/workflows/${run.temporalWorkflow.workflowId}/${run.temporalWorkflow.runId}`
      : undefined;

  const sentryUrl = env.VITE_SENTRY_URL
    ? `${env.VITE_SENTRY_URL}/explore/logs/?logsFields=timestamp&logsFields=message&logsQuery=run_id%3A${run.id}&logsSortBys=-timestamp&statsPeriod=1h`
    : undefined;

  const testUrl = `/app/${currentApp.slug}/tests/${run.testCaseSlug}`;

  const lightboxSteps: NavigableStep[] = steps
    .filter((step) => (step.screenshotBefore ?? step.screenshotAfter) != null)
    .map((step) => {
      const src = step.screenshotBefore ?? step.screenshotAfter ?? "";
      const points = getStepOverlayPoints(step.output as Parameters<typeof getStepOverlayPoints>[0]);
      return {
        src,
        alt: `Step ${step.order} - ${stepInstruction(step)}`,
        points,
        stepNumber: step.order,
        description: stepInstruction(step),
      };
    });

  function handleRerun() {
    restartRun.mutate({ runId });
  }

  function handleDeleteSuccess() {
    void navigate({ to: "/app/$appSlug/runs" });
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="shrink-0 space-y-4 px-6 pt-6">
        <section className="flex items-center justify-between">
          <a
            href={`/app/${currentApp.slug}/runs`}
            className="inline-flex items-center gap-1.5 text-sm text-text-tertiary transition-colors hover:text-text-primary"
          >
            <ArrowLeft size={14} />
            Runs
          </a>
          <div className="hidden items-center gap-2 font-mono text-2xs text-text-tertiary sm:flex">
            <span>{run.shortId}</span>
            <CaretRight size={12} />
            <a href={testUrl} className="transition-colors hover:text-text-primary">
              {currentApp.name}
            </a>
            {run.startedAt != null && (
              <>
                <CaretRight size={12} />
                <span>{formatDate(new Date(run.startedAt))}</span>
              </>
            )}
          </div>
        </section>

        <div className="flex items-start justify-between gap-6 border border-border-dim bg-surface-raised p-5">
          <div className="min-w-0 flex-1">
            <a href={testUrl} className="group inline-flex items-center gap-1.5">
              <h1 className="text-2xl font-medium tracking-tight text-text-primary transition-colors group-hover:text-primary">
                {run.name}
              </h1>
            </a>
            <div className="mt-1.5 flex items-center gap-3 font-mono text-xs text-text-tertiary">
              <span>
                {steps.length} {steps.length === 1 ? "step" : "steps"}
              </span>
              {run.duration != null && <span>{run.duration}</span>}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {isAdmin && reviewStatus === "completed" && review?.issue != null && (
              <AppLink to="/app/$appSlug/issues/$issueId" params={{ issueId: review.issue.id }}>
                <Badge variant="success" className="h-7 cursor-pointer gap-1.5 px-3 text-xs">
                  <CheckCircleIcon size={14} weight="fill" />
                  Reviewed
                </Badge>
              </AppLink>
            )}
            {isAdmin && reviewStatus === "pending" && (
              <Badge variant="status-running" className="h-7 gap-1.5 px-3 text-xs">
                <BrailleSpinner animation="scan" size="sm" />
                Review in progress
              </Badge>
            )}
            {isAdmin && reviewStatus === "failed" && (
              <Badge variant="critical" className="h-7 gap-1.5 px-3 text-xs">
                <WarningIcon size={14} weight="fill" />
                Review failed
              </Badge>
            )}
            {isAdmin && status === "failed" && (review == null || reviewStatus === "failed") && (
              <Button
                variant="outline"
                size="sm"
                disabled={requestReview.isPending}
                onClick={() => requestReview.mutate({ runId })}
              >
                <MagnifyingGlassIcon size={14} />
                {reviewStatus === "failed" ? "Retry review" : "Review"}
              </Button>
            )}
            {isAdmin && (
              <>
                {temporalUrl != null && (
                  <a href={temporalUrl} target="_blank" rel="noopener noreferrer">
                    <Button variant="outline" size="sm" className="size-7 p-0">
                      <Temporal className="size-4" />
                    </Button>
                  </a>
                )}
                {sentryUrl != null && (
                  <a href={sentryUrl} target="_blank" rel="noopener noreferrer">
                    <Button variant="outline" size="sm" className="size-7 p-0">
                      <Sentry className="size-4" />
                    </Button>
                  </a>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRerun}
                  disabled={restartRun.isPending}
                  aria-label="rerun-run"
                >
                  <ArrowsClockwiseIcon size={14} />
                  Re-run
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="size-7 p-0 text-status-critical hover:border-status-critical hover:text-status-critical"
                  onClick={() => setDeleteDialogOpen(true)}
                  aria-label="delete-run"
                >
                  <Trash size={14} />
                </Button>
              </>
            )}
            <Badge variant={toRunBadgeVariant(status)}>{toRunStatusLabel(status)}</Badge>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex min-h-0 flex-1 gap-6 overflow-hidden px-6 py-5 pb-6">
        {/* Sidebar */}
        <div className="hidden w-72 shrink-0 overflow-y-auto lg:block">
          <RunDetailSidebar
            status={status}
            startedAt={run.startedAt != null ? new Date(run.startedAt) : undefined}
            stepCount={steps.length}
            duration={run.duration ?? undefined}
            reasoning={status === "failed" ? (run.reasoning ?? undefined) : undefined}
            testUrl={testUrl}
            testName={run.name}
          />
        </div>

        {/* Steps */}
        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          {steps.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 border border-dashed border-border-dim py-14 text-center">
              <Stack size={24} className="text-text-tertiary" />
              <p className="text-sm text-text-tertiary">
                {status === "running" || status === "pending"
                  ? "Steps will appear here as the test runs..."
                  : "No steps recorded"}
              </p>
            </div>
          ) : (
            <div>
              {steps.map((step, i) => {
                const hasScreenshot = (step.screenshotBefore ?? step.screenshotAfter) != null;
                const lightboxIdx = hasScreenshot ? lightboxSteps.findIndex((ls) => ls.stepNumber === step.order) : -1;
                return (
                  <StepCard
                    key={step.id}
                    step={step}
                    isLast={i === steps.length - 1}
                    onImageClick={lightboxIdx >= 0 ? () => setLightboxIndex(lightboxIdx) : undefined}
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>

      <NavigableLightbox
        steps={lightboxSteps}
        activeIndex={lightboxIndex}
        onClose={() => setLightboxIndex(undefined)}
        onNavigate={setLightboxIndex}
      />

      <DeleteRunDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        runId={runId}
        runName={run.name}
        onSuccess={handleDeleteSuccess}
      />
    </div>
  );
}

function computeRefetchInterval(query: { state: { data: unknown } }) {
  const data = query.state.data;
  const status = data != null && typeof data === "object" && "status" in data ? (data.status as RunStatus) : undefined;
  if (status === "running" || status === "pending") return 5000;
  return false as const;
}

// --- Sidebar ---

interface RunDetailSidebarProps {
  status: RunStatus;
  startedAt?: Date;
  stepCount: number;
  duration?: string;
  reasoning?: string;
  testUrl: string;
  testName: string;
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-2xs font-semibold uppercase tracking-widest text-text-tertiary">{label}</span>
      <div className="text-sm text-text-secondary">{children}</div>
    </div>
  );
}

function RunDetailSidebar({
  status,
  startedAt,
  stepCount,
  duration,
  reasoning,
  testUrl,
  testName,
}: RunDetailSidebarProps) {
  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <PanelBody className="flex flex-col gap-5 p-5">
          <DetailRow label="Test">
            <a href={testUrl} className="font-medium text-text-primary transition-colors hover:text-primary">
              {testName}
            </a>
          </DetailRow>

          <Separator />

          <DetailRow label="Status">
            <Badge variant={toRunBadgeVariant(status)} className="mt-1">
              {toRunStatusLabel(status)}
            </Badge>
          </DetailRow>

          {startedAt != null && (
            <DetailRow label="Started">
              <span>{formatDate(startedAt)}</span>
            </DetailRow>
          )}

          <DetailRow label="Steps">
            <span className="font-medium">{stepCount}</span>
            <span className="ml-1 text-text-tertiary">{stepCount === 1 ? "step" : "steps"}</span>
          </DetailRow>

          {duration != null && (
            <>
              <Separator />
              <DetailRow label="Duration">
                <span className="font-mono font-medium">{duration}</span>
              </DetailRow>
            </>
          )}
        </PanelBody>
      </Panel>

      {reasoning != null && (
        <div className="border border-status-warn/30 bg-status-warn/5 p-5">
          <div className="mb-3 flex items-center gap-2">
            <LightbulbIcon size={14} className="text-status-warn" />
            <span className="font-mono text-2xs font-semibold uppercase tracking-widest text-status-warn">
              Failure reason
            </span>
          </div>
          <p className="text-sm leading-relaxed text-text-secondary">{reasoning}</p>
        </div>
      )}
    </div>
  );
}

// --- Step Card ---

function StepCard({ step, isLast, onImageClick }: { step: RunStep; isLast: boolean; onImageClick?: () => void }) {
  const screenshot = step.screenshotBefore ?? step.screenshotAfter;
  const instruction = stepInstruction(step);

  return (
    <div className="flex gap-4">
      <div className="mt-0.5 flex flex-col items-center">
        <div className="flex size-6 shrink-0 items-center justify-center border border-border-dim bg-surface-base">
          <span className="font-mono text-3xs text-text-tertiary">{step.order}</span>
        </div>
        {!isLast && <div className="mt-1 h-full w-px bg-border-dim" />}
      </div>

      <div className="mb-3 flex-1 overflow-hidden border border-border-dim bg-surface-raised">
        <div className="flex">
          {screenshot != null && (
            <div
              role="button"
              className="relative aspect-video w-52 shrink-0 overflow-hidden border-r border-border-dim bg-surface-base cursor-zoom-in"
              onClick={onImageClick}
            >
              <img
                src={screenshot}
                alt={`Step ${step.order}`}
                className="absolute inset-0 h-full w-full object-cover"
              />
            </div>
          )}
          <div className="flex flex-1 flex-col justify-center gap-2 px-4 py-3">
            <p className="text-sm font-medium leading-snug text-text-primary">{instruction}</p>
            <Badge variant="outline" className="w-fit font-mono text-3xs uppercase">
              {step.interaction}
            </Badge>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Skeleton ---

function RunDetailSkeleton() {
  return (
    <div className="flex-1 p-6">
      <Skeleton className="mb-6 h-4 w-32" />
      <div className="mb-8">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-8 w-72" />
            <Skeleton className="h-4 w-40" />
          </div>
          <Skeleton className="h-7 w-20" />
        </div>
      </div>
      <div className="flex gap-6">
        <div className="w-72 shrink-0">
          <div className="border border-border-dim bg-surface-raised p-5">
            <div className="flex flex-col gap-5">
              {["sk-1", "sk-2", "sk-3"].map((id) => (
                <div key={id} className="flex flex-col gap-1.5">
                  <Skeleton className="h-3 w-16" />
                  <Skeleton className="h-5 w-32" />
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="flex flex-1 flex-col gap-3">
          {["step-1", "step-2", "step-3", "step-4"].map((id, i) => (
            <div key={id} className="flex gap-3">
              <div className="flex flex-col items-center">
                <Skeleton className="size-6" />
                {i < 3 && <div className="mt-1 h-20 w-px bg-border-dim" />}
              </div>
              <Skeleton className="mb-3 h-24 flex-1" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function NotFoundRun() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <p className="text-sm font-medium text-text-primary">Run not found</p>
      <p className="text-sm text-text-secondary">This run may have been deleted.</p>
    </div>
  );
}
