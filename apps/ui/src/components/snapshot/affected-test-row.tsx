import { Badge } from "@autonoma/blacklight";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { useState } from "react";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";
import type { AffectedTest } from "./diffs-timeline-types";

const REASON_BADGE: Record<AffectedTest["affectedReason"], { label: string; variant: "warn" | "critical" | "high" }> = {
  code_change: { label: "code change", variant: "warn" },
  merge_plan_imported: { label: "merge plan", variant: "high" },
  merge_conflict: { label: "merge conflict", variant: "critical" },
};

type NameLink = { kind: "test" } | { kind: "run"; runId: string } | { kind: "generation"; generationId: string };

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
  const [expanded, setExpanded] = useState(false);
  const reasonBadge = REASON_BADGE[test.affectedReason];

  const nameClassName = "min-w-0 flex-1 truncate font-mono text-sm text-text-primary hover:underline";
  const nameNode =
    nameLink.kind === "run" ? (
      <AppLink to="/app/$appSlug/runs/$runId" params={{ runId: nameLink.runId }} className={nameClassName}>
        {test.testCase.name}
      </AppLink>
    ) : nameLink.kind === "generation" ? (
      <AppLink
        to="/app/$appSlug/generations/$generationId"
        params={{ generationId: nameLink.generationId }}
        className={nameClassName}
      >
        {test.testCase.name}
      </AppLink>
    ) : (
      <AppLink to="/app/$appSlug/tests/$testSlug" params={{ testSlug: test.testCase.slug }} className={nameClassName}>
        {test.testCase.name}
      </AppLink>
    );

  return (
    <div className="border border-border-dim bg-surface-raised">
      <div className="flex items-center gap-3 px-4 py-3">
        <Badge variant={reasonBadge.variant} className="shrink-0">
          {reasonBadge.label}
        </Badge>
        {nameNode}
        {rightSlot}
        {showReasoning && test.reasoning.trim().length > 0 && (
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            aria-expanded={expanded}
            aria-label={expanded ? "Hide reasoning" : "Show reasoning"}
            className="inline-flex size-6 shrink-0 items-center justify-center text-text-tertiary transition-colors hover:bg-surface-base hover:text-text-primary"
          >
            <CaretDownIcon size={12} className={`transition-transform ${expanded ? "rotate-180" : ""}`} />
          </button>
        )}
      </div>
      {expanded && (
        <div className="border-t border-border-dim bg-surface-base px-4 py-3">
          <p className="text-xs leading-relaxed text-text-secondary">{test.reasoning}</p>
        </div>
      )}
    </div>
  );
}
