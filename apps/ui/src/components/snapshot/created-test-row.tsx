import { Badge } from "@autonoma/blacklight";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";
import type { CreatedTest } from "./diffs-timeline-types";
import { PipelineIds } from "./pipeline-ids";

const STATUS_BADGE: Record<string, "status-pending" | "status-running" | "status-passed" | "status-failed"> = {
  pending: "status-pending",
  queued: "status-pending",
  running: "status-running",
  success: "status-passed",
  failed: "status-failed",
};

interface CreatedTestRowProps {
  test: CreatedTest;
}

export function CreatedTestRow({ test }: CreatedTestRowProps) {
  const description = test.description?.trim() ?? "";
  const generationReview = test.generation?.reviewReasoning?.trim() ?? "";
  const runReview = test.run?.reviewReasoning?.trim() ?? "";
  const plan = test.plan.trim();
  const hasDetails = description.length > 0 || plan.length > 0 || generationReview.length > 0 || runReview.length > 0;

  return (
    <div className="border border-border-dim bg-surface-raised">
      <div className="flex items-center gap-3 px-4 py-3">
        <Badge variant="success" className="shrink-0">
          new
        </Badge>
        <AppLink
          to="/app/$appSlug/tests/$testSlug"
          params={{ testSlug: test.testCase.slug }}
          className="min-w-0 flex-1 truncate font-mono text-sm text-text-primary hover:underline"
        >
          {test.testCase.name}
        </AppLink>
        {test.generation != null && <StatusBadge label="gen" status={test.generation.status} />}
        {test.run != null && <StatusBadge label="run" status={test.run.status} />}
      </div>
      <PipelineIds
        ids={[
          { label: "test", value: test.testCase.id },
          { label: "generation", value: test.generation?.id },
          { label: "run", value: test.run?.id },
        ]}
        className="border-t border-border-dim bg-surface-base px-4 py-2"
      />
      {hasDetails && (
        <div className="flex flex-col gap-3 border-t border-border-dim bg-surface-base px-4 py-3">
          {description.length > 0 && <ReasoningSection label="Description" content={description} />}
          {plan.length > 0 && <ReasoningSection label="Plan" content={plan} />}
          {generationReview.length > 0 && <ReasoningSection label="Generation review" content={generationReview} />}
          {runReview.length > 0 && <ReasoningSection label="Run review" content={runReview} />}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ label, status }: { label: string; status: string }) {
  return (
    <Badge variant={STATUS_BADGE[status] ?? "outline"} className="shrink-0 px-1.5 py-0 text-3xs">
      {label} {status}
    </Badge>
  );
}

function ReasoningSection({ label, content }: { label: string; content: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-2xs font-semibold uppercase tracking-widest text-text-secondary">{label}</span>
      <p className="whitespace-pre-wrap text-xs leading-relaxed text-text-primary">{content}</p>
    </div>
  );
}
