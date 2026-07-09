import { Badge } from "@autonoma/blacklight";
import { Link } from "@tanstack/react-router";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";
import { useCurrentApplication } from "routes/_blacklight/_app-shell/-use-current-application";
import type { AffectedTest } from "./diffs-timeline-types";
import { PipelineIds } from "./pipeline-ids";

const REASON_BADGE: Record<AffectedTest["affectedReason"], { label: string; variant: "warn" | "critical" | "high" }> = {
  code_change: { label: "code change", variant: "warn" },
  merge_plan_imported: { label: "merge plan", variant: "high" },
  merge_conflict: { label: "merge conflict", variant: "critical" },
};

type NameLink =
  | { kind: "test" }
  | { kind: "generation"; generationId: string }
  | { kind: "pr-suite"; prNumber: number };

interface AffectedTestRowProps {
  test: AffectedTest;
  rightSlot?: React.ReactNode;
  showReasoning?: boolean;
  nameLink?: NameLink;
}

export function AffectedTestRow({
  test,
  rightSlot,
  showReasoning = true,
  nameLink = { kind: "test" },
}: AffectedTestRowProps) {
  const reasonBadge = REASON_BADGE[test.affectedReason];
  const app = useCurrentApplication();

  const nameClassName = "min-w-0 flex-1 truncate font-mono text-sm text-text-primary hover:underline";
  const nameNode =
    nameLink.kind === "generation" ? (
      <AppLink
        to="/app/$appSlug/generations/$generationId"
        params={{ generationId: nameLink.generationId }}
        className={nameClassName}
      >
        {test.testCase.name}
      </AppLink>
    ) : nameLink.kind === "pr-suite" ? (
      <Link
        to="/app/$appSlug/pull-requests/$prNumber/suite"
        params={{ appSlug: app.slug, prNumber: nameLink.prNumber }}
        search={{ testSlug: test.testCase.slug }}
        className={nameClassName}
      >
        {test.testCase.name}
      </Link>
    ) : (
      <AppLink to="/app/$appSlug/tests/$testSlug" params={{ testSlug: test.testCase.slug }} className={nameClassName}>
        {test.testCase.name}
      </AppLink>
    );

  const whyAffected = showReasoning ? test.reasoning.trim() : "";
  const generationReview = test.generation?.generationReview?.reasoning?.trim() ?? "";
  const hasDetails = whyAffected.length > 0 || generationReview.length > 0;

  return (
    <div className="border border-border-dim bg-surface-raised">
      <div className="flex items-center gap-3 px-4 py-3">
        <Badge variant={reasonBadge.variant} className="shrink-0">
          {reasonBadge.label}
        </Badge>
        {nameNode}
        {rightSlot}
      </div>
      <PipelineIds
        ids={[
          { label: "test", value: test.testCase.id },
          { label: "generation", value: test.generation?.id },
        ]}
        className="border-t border-border-dim bg-surface-base px-4 py-2"
      />
      {hasDetails && (
        <div className="flex flex-col gap-3 border-t border-border-dim bg-surface-base px-4 py-3">
          {whyAffected.length > 0 && <ReasoningSection label="Why this test is affected" content={whyAffected} />}
          {generationReview.length > 0 && <ReasoningSection label="Generation review" content={generationReview} />}
        </div>
      )}
    </div>
  );
}

function ReasoningSection({ label, content }: { label: string; content: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-2xs font-semibold uppercase tracking-widest text-text-tertiary">{label}</span>
      <p className="whitespace-pre-wrap text-xs leading-relaxed text-text-primary">{content}</p>
    </div>
  );
}
