import {
  Badge,
  BrailleSpinner,
  Button,
  Panel,
  PanelBody,
  ScrollArea,
  Separator,
  Skeleton,
  stepInstruction as getStepInstruction,
  getStepOverlayPoints,
} from "@autonoma/blacklight";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react/ArrowsClockwise";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { FileTextIcon } from "@phosphor-icons/react/FileText";
import { LightbulbIcon } from "@phosphor-icons/react/Lightbulb";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/MagnifyingGlass";
import { StackIcon } from "@phosphor-icons/react/Stack";
import { VideoCameraIcon } from "@phosphor-icons/react/VideoCamera";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { createFileRoute } from "@tanstack/react-router";
import { Temporal } from "components/icons";
import { NavigableLightbox, type NavigableStep, ScreenshotLightbox } from "components/screenshot-lightbox";
import { env } from "env";
import { useAuth } from "lib/auth";
import { formatDate } from "lib/format";
import { ensureGenerationDetailData, useGenerationDetail } from "lib/query/generations.queries";
import { useRequestReview } from "lib/query/issues.queries";
import { useState } from "react";
import Markdown from "react-markdown";
import { toGenerationBadgeVariant, toGenerationStatusLabel } from "../../-home/helpers";
import { AppLink } from "../../../-app-link";
import { useCurrentApplication } from "../../../-use-current-application";
import { RerunGenerationDialog } from "./-rerun-generation-dialog";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/generations/$generationId/")({
  loader: async ({ context: { queryClient }, params: { generationId } }) => {
    await ensureGenerationDetailData(queryClient, generationId);
  },
  pendingComponent: GenerationDetailSkeleton,
  notFoundComponent: NotFoundGeneration,
  component: GenerationDetailPage,
});

type GenerationStatus = "pending" | "queued" | "running" | "success" | "failed";

interface GenerationStep {
  id: string;
  order: number;
  interaction: string;
  params: unknown;
  output?: object;
  screenshotBefore: string | null | undefined;
  screenshotAfter: string | null | undefined;
}

function stepDescription(step: GenerationStep): React.ReactNode {
  return getStepInstruction({ interaction: step.interaction, params: step.params });
}

function GenerationDetailPage() {
  const { generationId } = Route.useParams();
  const [showPlan, setShowPlan] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | undefined>(undefined);
  const currentApp = useCurrentApplication();
  const { isAdmin } = useAuth();
  const [showRerun, setShowRerun] = useState(false);
  const requestReview = useRequestReview();
  const { data: generation } = useGenerationDetail(generationId);

  const status = generation.status as GenerationStatus;
  const isActive = status === "queued" || status === "running";
  const temporalBaseUrl = env.VITE_TEMPORAL_URL?.replace(/\/$/, "");
  const temporalUrl =
    temporalBaseUrl != null && generation.temporalWorkflow != null
      ? `${temporalBaseUrl}/namespaces/${env.VITE_TEMPORAL_NAMESPACE}/workflows/${generation.temporalWorkflow.workflowId}/${generation.temporalWorkflow.runId}`
      : undefined;

  const review = generation.review;
  const reviewStatus = review?.status;

  const lightboxSteps: NavigableStep[] = generation.steps
    .filter((step: GenerationStep) => (step.screenshotBefore ?? step.screenshotAfter) != null)
    .map((step: GenerationStep) => {
      const src = step.screenshotBefore ?? step.screenshotAfter ?? "";
      const output = step.output as Record<string, unknown> | undefined;
      const points = output != null ? getStepOverlayPoints(output as Parameters<typeof getStepOverlayPoints>[0]) : [];
      return {
        src,
        alt: `Step ${step.order} - ${stepDescription(step)}`,
        points,
        stepNumber: step.order,
        description: stepDescription(step),
      };
    });

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="shrink-0 space-y-4 px-6 pt-6">
        <section className="flex items-center justify-between">
          <AppLink
            to="/app/$appSlug/generations"
            className="inline-flex items-center gap-1.5 text-sm text-text-tertiary transition-colors hover:text-text-primary"
          >
            <ArrowLeftIcon size={14} />
            Generations
          </AppLink>
          <div className="hidden items-center gap-2 font-mono text-2xs text-text-tertiary sm:flex">
            <span>{generation.shortId}</span>
            <CaretRightIcon size={12} />
            <span>{currentApp.name}</span>
            <CaretRightIcon size={12} />
            <span>{formatDate(generation.createdAt)}</span>
          </div>
        </section>

        <div className="flex items-start justify-between gap-6 border border-border-dim bg-surface-raised p-5">
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-medium tracking-tight text-text-primary">{generation.testPlan.name}</h1>
          </div>
          <div className="flex shrink-0 items-center gap-3">
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
                onClick={() => requestReview.mutate({ generationId })}
              >
                <MagnifyingGlassIcon size={14} />
                {reviewStatus === "failed" ? "Retry review" : "Review"}
              </Button>
            )}
            {isAdmin && (
              <Button variant="outline" size="sm" onClick={() => setShowRerun(true)} aria-label="rerun-generation">
                <ArrowsClockwiseIcon size={14} />
                Re-run
              </Button>
            )}
            {isAdmin && temporalUrl != null && (
              <a href={temporalUrl} target="_blank" rel="noopener noreferrer">
                <Button variant="outline" size="sm" className="size-7 p-0">
                  <Temporal className="size-4" />
                </Button>
              </a>
            )}
            <Button
              variant={showPlan ? "default" : "outline"}
              size="sm"
              onClick={() => setShowPlan(!showPlan)}
              aria-label="toggle-generation-plan"
            >
              <FileTextIcon size={14} />
              {showPlan ? "Close plan" : "View plan"}
            </Button>
            <Badge variant={toGenerationBadgeVariant(status)} className="h-7 px-3 text-xs">
              {toGenerationStatusLabel(status)}
            </Badge>
          </div>
        </div>
      </div>

      {/* Content area: sidebar + steps + plan */}
      <div className="flex min-h-0 flex-1 gap-6 overflow-hidden px-6 py-5 pb-6">
        {/* Sidebar */}
        {!showPlan && (
          <div className="hidden w-72 shrink-0 overflow-y-auto lg:block">
            <GenerationDetailSidebar
              status={status}
              createdAt={generation.createdAt}
              stepCount={generation.steps.length}
              reasoning={generation.reasoning ?? undefined}
              reasoningScreenshot={generation.finalScreenshot ?? undefined}
              videoUrl={generation.videoUrl ?? undefined}
              test={generation.testCase ?? undefined}
            />
          </div>
        )}

        {/* Steps */}
        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          {generation.steps.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 border border-dashed border-border-dim py-14 text-center">
              <StackIcon size={24} className="text-text-tertiary" />
              <p className="text-sm text-text-tertiary">
                {isActive ? "Steps will appear here as the AI generates them..." : "No steps recorded"}
              </p>
            </div>
          ) : (
            <div>
              {generation.steps.map((step: GenerationStep, i: number) => {
                const hasScreenshot = (step.screenshotBefore ?? step.screenshotAfter) != null;
                const lightboxIdx = hasScreenshot ? lightboxSteps.findIndex((ls) => ls.stepNumber === step.order) : -1;
                return (
                  <StepCard
                    key={step.id}
                    step={step}
                    isLast={i === generation.steps.length - 1}
                    onImageClick={lightboxIdx >= 0 ? () => setLightboxIndex(lightboxIdx) : undefined}
                  />
                );
              })}
            </div>
          )}
        </div>

        {/* Plan panel */}
        {showPlan && (
          <div className="hidden w-1/2 shrink-0 overflow-hidden lg:block">
            <PlanPanel content={generation.testPlan.plan} />
          </div>
        )}
      </div>

      {isAdmin && (
        <RerunGenerationDialog
          open={showRerun}
          onOpenChange={setShowRerun}
          generationId={generationId}
          currentPlan={generation.testPlan.plan}
        />
      )}

      <NavigableLightbox
        steps={lightboxSteps}
        activeIndex={lightboxIndex}
        onClose={() => setLightboxIndex(undefined)}
        onNavigate={setLightboxIndex}
      />
    </div>
  );
}

// --- Sidebar ---

interface GenerationDetailSidebarProps {
  status: GenerationStatus;
  createdAt: Date;
  stepCount: number;
  reasoning?: string;
  reasoningScreenshot?: string;
  videoUrl?: string;
  test?: { id: string; name: string; slug: string };
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-2xs font-semibold uppercase tracking-widest text-text-tertiary">{label}</span>
      <div className="text-sm text-text-secondary">{children}</div>
    </div>
  );
}

function GenerationDetailSidebar({
  status,
  createdAt,
  stepCount,
  reasoning,
  reasoningScreenshot,
  videoUrl,
  test,
}: GenerationDetailSidebarProps) {
  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <PanelBody className="flex flex-col gap-5 p-5">
          <DetailRow label="Status">
            <Badge variant={toGenerationBadgeVariant(status)} className="mt-1">
              {toGenerationStatusLabel(status)}
            </Badge>
          </DetailRow>

          <DetailRow label="Created">
            <span>{formatDate(createdAt)}</span>
          </DetailRow>

          <DetailRow label="Steps">
            <span className="font-medium">{stepCount}</span>
            <span className="ml-1 text-text-tertiary">{stepCount === 1 ? "step" : "steps"}</span>
          </DetailRow>

          {test != null && (
            <>
              <Separator />
              <DetailRow label="Generated Test">
                <AppLink
                  to="/app/$appSlug/tests/$testSlug"
                  params={{ testSlug: test.slug }}
                  className="inline-flex items-center gap-1 font-medium text-primary-ink hover:underline"
                >
                  {test.name}
                </AppLink>
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
              Reasoning
            </span>
          </div>
          {reasoningScreenshot != null && (
            <div className="mb-3">
              <ScreenshotLightbox
                src={reasoningScreenshot}
                alt="Last step screenshot"
                className="w-full border border-status-warn/20"
              />
            </div>
          )}
          <p className="text-sm leading-relaxed text-text-secondary">{reasoning}</p>
        </div>
      )}

      {videoUrl != null && (
        <Panel>
          <PanelBody className="p-5">
            <div className="mb-3 flex items-center gap-2">
              <VideoCameraIcon size={14} className="text-text-tertiary" />
              <span className="font-mono text-2xs font-semibold uppercase tracking-widest text-text-tertiary">
                Recording
              </span>
            </div>
            <video controls className="w-full" playsInline>
              <source src={videoUrl} type="video/webm" />
              <track default kind="captions" label="English" src={`${videoUrl}.vtt`} srcLang="en" />
            </video>
          </PanelBody>
        </Panel>
      )}
    </div>
  );
}

// --- Step Card ---

function StepCard({
  step,
  isLast,
  onImageClick,
}: {
  step: GenerationStep;
  isLast: boolean;
  onImageClick?: () => void;
}) {
  const screenshot = step.screenshotBefore ?? step.screenshotAfter;
  const instruction = stepDescription(step);

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
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-medium leading-snug text-text-primary">{instruction}</p>
              <span className="shrink-0 font-mono text-2xs font-medium text-text-tertiary">#{step.order}</span>
            </div>
            <Badge variant="outline" className="w-fit font-mono text-3xs uppercase">
              {step.interaction}
            </Badge>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Plan Panel ---

function PlanPanel({ content }: { content: string }) {
  return (
    <div className="flex h-full flex-col overflow-hidden border border-border-dim">
      <div className="flex shrink-0 items-center gap-2 border-b border-border-dim bg-surface-base px-4 py-3">
        <FileTextIcon size={14} className="text-text-tertiary" />
        <span className="font-mono text-2xs font-medium uppercase tracking-wider text-text-tertiary">Test Plan</span>
      </div>
      <ScrollArea className="flex-1 bg-surface-raised">
        <div className="p-5">
          <article className="prose prose-sm prose-invert max-w-none">
            <Markdown
              components={{
                h1: ({ children }) => (
                  <h1 className="mb-3 border-b border-border-dim pb-2 text-base font-semibold text-text-primary">
                    {children}
                  </h1>
                ),
                h2: ({ children }) => <h2 className="mb-2 mt-5 text-sm font-semibold text-text-primary">{children}</h2>,
                h3: ({ children }) => <h3 className="mb-1.5 mt-4 text-sm font-medium text-text-primary">{children}</h3>,
                p: ({ children }) => <p className="mb-3 text-sm leading-relaxed text-text-secondary">{children}</p>,
                strong: ({ children }) => <strong className="font-semibold text-text-primary">{children}</strong>,
                code: ({ children }) => (
                  <code className="rounded bg-surface-base px-1.5 py-0.5 font-mono text-xs text-text-primary">
                    {children}
                  </code>
                ),
                ul: ({ children }) => (
                  <ul className="mb-3 list-inside list-disc space-y-1 text-sm text-text-secondary">{children}</ul>
                ),
                ol: ({ children }) => (
                  <ol className="mb-3 list-inside list-decimal space-y-1 text-sm text-text-secondary">{children}</ol>
                ),
                li: ({ children }) => <li className="text-sm text-text-secondary">{children}</li>,
                a: ({ href, children }) => (
                  <a
                    href={href}
                    className="text-primary-ink underline underline-offset-2 hover:text-primary-ink/80"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {children}
                  </a>
                ),
                hr: () => <hr className="my-4 border-border-dim" />,
              }}
            >
              {content}
            </Markdown>
          </article>
        </div>
      </ScrollArea>
    </div>
  );
}

// --- Skeleton ---

function GenerationDetailSkeleton() {
  return (
    <div className="flex-1 p-6">
      <Skeleton className="mb-6 h-4 w-32" />
      <div className="mb-8">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-8 w-72" />
            <Skeleton className="h-4 w-full max-w-lg" />
          </div>
          <Skeleton className="h-7 w-24" />
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

function NotFoundGeneration() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <p className="text-sm font-medium text-text-primary">Generation not found</p>
      <p className="text-sm text-text-secondary">This generation may have been deleted.</p>
    </div>
  );
}
