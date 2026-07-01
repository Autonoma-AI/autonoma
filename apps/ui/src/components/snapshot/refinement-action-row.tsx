import { Badge, cn } from "@autonoma/blacklight";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { useState } from "react";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";
import { PipelineIds } from "./pipeline-ids";
import { ReasoningBlock } from "./reasoning-block";
import type { RefinementAction } from "./refinement-types";

interface RefinementActionRowProps {
  action: RefinementAction;
}

const KIND_LABEL: Record<RefinementAction["kind"], string> = {
  update_plan: "update plan",
  report_bug: "report bug",
  report_engine_limitation: "engine limitation",
  report_unknown_issue: "unknown issue",
  report_scenario_unsupported: "scenario unsupported",
  remove_test: "remove test",
};

const KIND_VARIANT: Record<RefinementAction["kind"], "warn" | "critical" | "high" | "outline" | "secondary"> = {
  update_plan: "warn",
  report_bug: "critical",
  report_engine_limitation: "high",
  report_unknown_issue: "secondary",
  report_scenario_unsupported: "secondary",
  remove_test: "outline",
};

export function RefinementActionRow({ action }: RefinementActionRowProps) {
  return (
    <div className="border border-border-dim bg-surface-raised">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <Badge variant={KIND_VARIANT[action.kind]} className="shrink-0">
          {KIND_LABEL[action.kind]}
        </Badge>
        <ActionTitle action={action} />
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {action.reviewLink != null && <CitedReviewLink reviewLink={action.reviewLink} />}
          {action.appliedAt != null ? (
            <Badge variant="status-passed" className="px-1.5 py-0 text-3xs">
              applied
            </Badge>
          ) : (
            <Badge variant="outline" className="px-1.5 py-0 text-3xs">
              not applied
            </Badge>
          )}
        </div>
      </div>
      <PipelineIds
        ids={[
          { label: "action", value: action.id },
          { label: "plan", value: action.plan?.id },
          { label: "test", value: action.testCase?.id ?? action.plan?.testCaseId },
        ]}
        className="border-t border-border-dim bg-surface-base px-4 py-2"
      />
      <div className="border-t border-border-dim bg-surface-base px-4 py-3">
        <ActionDetail action={action} />
        {action.reasoning.trim().length > 0 && (
          <div className="mt-3">
            <ReasoningBlock label="Reasoning" content={action.reasoning} />
          </div>
        )}
      </div>
    </div>
  );
}

function CitedReviewLink({ reviewLink }: { reviewLink: NonNullable<RefinementAction["reviewLink"]> }) {
  const className =
    "inline-flex items-center gap-1 font-mono text-2xs uppercase tracking-widest text-text-secondary transition-colors hover:text-text-primary hover:underline";
  if (reviewLink.kind === "generation") {
    return (
      <AppLink
        to="/app/$appSlug/generations/$generationId"
        params={{ generationId: reviewLink.id }}
        className={className}
      >
        <ArrowSquareOutIcon size={11} />
        cited review
      </AppLink>
    );
  }
  return (
    <AppLink to="/app/$appSlug/runs/$runId" params={{ runId: reviewLink.id }} className={className}>
      <ArrowSquareOutIcon size={11} />
      cited review
    </AppLink>
  );
}

function ActionTitle({ action }: { action: RefinementAction }) {
  const className = "min-w-0 flex-1 truncate font-mono text-sm text-text-primary hover:underline";

  if (action.testCase != null) {
    return (
      <AppLink to="/app/$appSlug/tests/$testSlug" params={{ testSlug: action.testCase.slug }} className={className}>
        {action.testCase.name}
      </AppLink>
    );
  }

  return <span className="min-w-0 flex-1 truncate font-mono text-sm text-text-tertiary">(no test case)</span>;
}

function ActionDetail({ action }: { action: RefinementAction }) {
  const payload = action.payload;
  switch (payload.kind) {
    case "update_plan":
      return <UpdatePlanDetail newPrompt={payload.newPrompt} />;
    case "report_bug":
    case "report_engine_limitation":
    case "report_unknown_issue":
    case "report_scenario_unsupported":
      return <ReportDetail title={payload.title} description={payload.description} severity={payload.severity} />;
    case "remove_test":
      return <RemoveTestDetail reason={payload.reason} />;
  }
}

function UpdatePlanDetail({ newPrompt }: { newPrompt: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <SectionLabel label="Rewrote plan prompt" />
      <button
        type="button"
        onClick={() => setExpanded((p) => !p)}
        aria-expanded={expanded}
        className="flex items-center gap-2 self-start text-2xs text-text-tertiary hover:text-text-primary"
      >
        <CaretDownIcon size={12} className={cn("transition-transform", expanded && "rotate-180")} />
        {expanded ? "hide" : "show"} new prompt
      </button>
      {expanded && (
        <pre className="whitespace-pre-wrap break-words border border-border-dim bg-surface-void px-3 py-2 font-mono text-xs leading-relaxed text-text-primary">
          {newPrompt}
        </pre>
      )}
    </div>
  );
}

function ReportDetail({
  title,
  description,
  severity,
}: {
  title: string;
  description: string;
  severity: "critical" | "high" | "medium" | "low";
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={severityVariant(severity)} className="shrink-0">
          {severity}
        </Badge>
        <span className="text-sm font-medium text-text-primary">{title}</span>
      </div>
      <button
        type="button"
        onClick={() => setExpanded((p) => !p)}
        aria-expanded={expanded}
        className="flex items-center gap-2 self-start text-2xs text-text-tertiary hover:text-text-primary"
      >
        <CaretDownIcon size={12} className={cn("transition-transform", expanded && "rotate-180")} />
        {expanded ? "hide" : "show"} description
      </button>
      {expanded && <p className="text-xs leading-relaxed text-text-primary">{description}</p>}
    </div>
  );
}

function RemoveTestDetail({ reason }: { reason: string }) {
  return (
    <div className="flex flex-col gap-1">
      <SectionLabel label="Reason for removal" />
      <p className="text-xs leading-relaxed text-text-primary">{reason}</p>
    </div>
  );
}

function SectionLabel({ label }: { label: string }) {
  return <span className="font-mono text-2xs uppercase tracking-widest text-text-tertiary">{label}</span>;
}

function severityVariant(severity: "critical" | "high" | "medium" | "low"): "critical" | "high" | "warn" | "outline" {
  switch (severity) {
    case "critical":
      return "critical";
    case "high":
      return "high";
    case "medium":
      return "warn";
    case "low":
      return "outline";
  }
}
