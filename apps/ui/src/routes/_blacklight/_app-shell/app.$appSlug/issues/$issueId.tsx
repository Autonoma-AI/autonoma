import { Badge, Panel, PanelBody, PanelHeader, PanelTitle, Separator, Skeleton } from "@autonoma/blacklight";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { CrosshairIcon } from "@phosphor-icons/react/Crosshair";
import { ListChecksIcon } from "@phosphor-icons/react/ListChecks";
import { ScalesIcon } from "@phosphor-icons/react/Scales";
import { createFileRoute } from "@tanstack/react-router";
import { DetailRow } from "components/detail-row";
import { EvidenceLightbox, type EvidenceMediaItem } from "components/evidence-lightbox";
import { formatDate } from "lib/format";
import { ensureIssueDetailData, useIssueDetail } from "lib/query/issues.queries";
import { useState } from "react";
import { AppLink } from "../../-app-link";
import { useCurrentApplication } from "../../-use-current-application";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/issues/$issueId")({
  loader: async ({ context: { queryClient }, params: { issueId } }) => {
    await ensureIssueDetailData(queryClient, issueId);
  },
  pendingComponent: IssueDetailSkeleton,
  component: IssueDetailPage,
});

type BadgeVariant = "critical" | "high" | "warn" | "secondary";

const SEVERITY_BADGE: Record<string, BadgeVariant> = {
  critical: "critical",
  high: "high",
  medium: "warn",
  low: "secondary",
};

type KindBadgeVariant = "status-failed" | "warn";

const KIND_BADGE: Record<string, KindBadgeVariant> = {
  application_bug: "status-failed",
  engine_limitation: "warn",
};

const KIND_LABEL: Record<string, string> = {
  application_bug: "Application Bug",
  engine_limitation: "Engine Limitation",
};

const EVIDENCE_TYPE_LABEL: Record<string, string> = {
  conversation: "Conversation",
  screenshot: "Screenshot",
  video: "Video",
  step_output: "Step Output",
};

function isMediaItem(item: { type: string; url?: string }): item is { type: "screenshot" | "video"; url: string } & {
  description: string;
} {
  return item.url != null && (item.type === "screenshot" || item.type === "video");
}

function IssueDetailPage() {
  const { issueId } = Route.useParams();
  const currentApp = useCurrentApplication();
  const { data: issue } = useIssueDetail(issueId);

  const failurePoint = issue.review.failurePoint as { stepOrder?: number; description?: string } | undefined;
  const evidence = (issue.review.evidence ?? []) as Array<{ type: string; description: string; url?: string }>;
  // Only media evidence (screenshots/videos) is navigable in the lightbox; non-media rows stay inline.
  const mediaEvidence: EvidenceMediaItem[] = evidence
    .filter(isMediaItem)
    .map((item) => ({ type: item.type, url: item.url, description: item.description }));
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const [activeMediaIndex, setActiveMediaIndex] = useState<number | undefined>(undefined);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 space-y-4 px-6 pt-6">
        <section className="flex items-center justify-between">
          <AppLink
            to="/app/$appSlug/tests/$testSlug"
            params={{ testSlug: issue.testCase.slug }}
            className="inline-flex items-center gap-1.5 text-sm text-text-tertiary transition-colors hover:text-text-primary"
          >
            <ArrowLeftIcon size={14} />
            {issue.testCase.name}
          </AppLink>
          <div className="hidden items-center gap-2 font-mono text-2xs text-text-tertiary sm:flex">
            <span>{issue.id.slice(0, 8)}</span>
            <CaretRightIcon size={12} />
            <span>{currentApp.name}</span>
            <CaretRightIcon size={12} />
            <span>{formatDate(issue.createdAt)}</span>
          </div>
        </section>

        <div className="flex items-start justify-between gap-6 border border-border-dim bg-surface-raised p-5">
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-medium tracking-tight text-text-primary">{issue.title}</h1>
            <p className="mt-1 text-sm text-text-secondary">{issue.testCase.name}</p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <Badge variant={KIND_BADGE[issue.kind] ?? "secondary"}>{KIND_LABEL[issue.kind] ?? issue.kind}</Badge>
            <Badge variant={SEVERITY_BADGE[issue.severity] ?? "secondary"} className="h-7 px-3 text-xs">
              {issue.severity}
            </Badge>
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 gap-6 overflow-y-auto px-6 py-5 pb-6">
        <div className="hidden w-72 shrink-0 lg:block">
          <div className="flex flex-col gap-4">
            <Panel>
              <PanelBody className="flex flex-col gap-5 p-5">
                <DetailRow label="Kind">
                  <Badge variant={KIND_BADGE[issue.kind] ?? "secondary"} className="mt-1">
                    {KIND_LABEL[issue.kind] ?? issue.kind}
                  </Badge>
                </DetailRow>

                <DetailRow label="Severity">
                  <Badge variant={SEVERITY_BADGE[issue.severity] ?? "secondary"} className="mt-1">
                    {issue.severity}
                  </Badge>
                </DetailRow>

                <DetailRow label="Created">
                  <span>{formatDate(issue.createdAt)}</span>
                </DetailRow>

                <Separator />

                <DetailRow label="Test Case">
                  <AppLink
                    to="/app/$appSlug/tests/$testSlug"
                    params={{
                      testSlug: issue.testCase.slug,
                    }}
                    className="inline-flex items-center gap-1 font-medium text-primary-ink hover:underline"
                  >
                    {issue.testCase.name}
                  </AppLink>
                </DetailRow>

                {issue.generation != null && (
                  <DetailRow label="Generation">
                    <AppLink
                      to="/app/$appSlug/generations/$generationId"
                      params={{
                        generationId: issue.generation.id,
                      }}
                      className="inline-flex items-center gap-1 font-mono text-sm text-primary-ink hover:underline"
                    >
                      {issue.generation.id.slice(0, 8)}
                      <ArrowSquareOutIcon size={12} />
                    </AppLink>
                  </DetailRow>
                )}
              </PanelBody>
            </Panel>
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-6">
          {failurePoint != null && failurePoint.description != null && (
            <Panel>
              <PanelHeader className="flex items-center gap-2">
                <CrosshairIcon size={14} className="text-status-critical" />
                <PanelTitle>Failure Point</PanelTitle>
                {failurePoint.stepOrder != null && (
                  <Badge variant="outline" className="ml-auto font-mono text-2xs">
                    Step {failurePoint.stepOrder}
                  </Badge>
                )}
              </PanelHeader>
              <PanelBody className="p-5">
                <p className="text-sm leading-relaxed text-text-primary">{failurePoint.description}</p>
              </PanelBody>
            </Panel>
          )}

          {evidence.length > 0 && (
            <Panel>
              <PanelHeader className="flex items-center gap-2">
                <ListChecksIcon size={14} className="text-text-tertiary" />
                <PanelTitle>Evidence</PanelTitle>
                <span className="ml-auto font-mono text-2xs text-text-tertiary">
                  {evidence.length} {evidence.length === 1 ? "item" : "items"}
                </span>
              </PanelHeader>
              <PanelBody className="p-0">
                {evidence.map((item, i) => {
                  const hasMedia = item.url != null && (item.type === "screenshot" || item.type === "video");
                  const borderClass = i < evidence.length - 1 ? "border-b border-border-dim" : "";

                  return hasMedia ? (
                    <button
                      key={`${item.type}-${item.description.slice(0, 20)}`}
                      type="button"
                      className={`flex w-full gap-4 px-5 py-4 text-left cursor-pointer transition-colors hover:bg-surface-base ${borderClass}`}
                      onClick={() => setActiveMediaIndex(mediaEvidence.findIndex((m) => m.url === item.url))}
                    >
                      <Badge variant="secondary" className="shrink-0 font-mono text-3xs uppercase">
                        {EVIDENCE_TYPE_LABEL[item.type] ?? item.type}
                      </Badge>
                      <p className="text-sm leading-relaxed text-text-primary">{item.description}</p>
                    </button>
                  ) : (
                    <div
                      key={`${item.type}-${item.description.slice(0, 20)}`}
                      className={`flex gap-4 px-5 py-4 ${borderClass}`}
                    >
                      <Badge variant="outline" className="shrink-0 font-mono text-3xs uppercase">
                        {EVIDENCE_TYPE_LABEL[item.type] ?? item.type}
                      </Badge>
                      <p className="text-sm leading-relaxed text-text-primary">{item.description}</p>
                    </div>
                  );
                })}
              </PanelBody>
            </Panel>
          )}

          <Panel>
            <PanelHeader
              role="button"
              tabIndex={0}
              aria-expanded={reasoningOpen}
              className="flex cursor-pointer items-center gap-2 select-none"
              onClick={() => setReasoningOpen((prev) => !prev)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setReasoningOpen((prev) => !prev);
                }
              }}
            >
              <ScalesIcon size={14} className="text-text-tertiary" />
              <PanelTitle>Reasoning</PanelTitle>
              <div className="ml-auto text-text-tertiary">
                {reasoningOpen ? <CaretDownIcon size={14} /> : <CaretRightIcon size={14} />}
              </div>
            </PanelHeader>
            {reasoningOpen && (
              <PanelBody className="p-5">
                <p className="text-xs leading-relaxed text-text-primary whitespace-pre-wrap">{issue.description}</p>
              </PanelBody>
            )}
          </Panel>
        </div>
      </div>

      <EvidenceLightbox
        items={mediaEvidence}
        activeIndex={activeMediaIndex}
        onClose={() => setActiveMediaIndex(undefined)}
        onNavigate={setActiveMediaIndex}
      />
    </div>
  );
}

function IssueDetailSkeleton() {
  return (
    <div className="flex-1 p-6">
      <Skeleton className="mb-6 h-4 w-32" />
      <div className="mb-8">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-8 w-72" />
            <Skeleton className="h-4 w-48" />
          </div>
          <div className="flex gap-2">
            <Skeleton className="h-7 w-28" />
            <Skeleton className="h-7 w-20" />
          </div>
        </div>
      </div>
      <div className="flex gap-6">
        <div className="w-72 shrink-0">
          <div className="border border-border-dim bg-surface-raised p-5">
            <div className="flex flex-col gap-5">
              {["sk-1", "sk-2", "sk-3", "sk-4"].map((id) => (
                <div key={id} className="flex flex-col gap-1.5">
                  <Skeleton className="h-3 w-16" />
                  <Skeleton className="h-5 w-32" />
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="flex flex-1 flex-col gap-6">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      </div>
    </div>
  );
}
