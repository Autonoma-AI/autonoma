import { Badge } from "@autonoma/blacklight";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { useState } from "react";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";
import type { TestCandidate } from "./diffs-timeline-types";

const STATUS_BADGE: Record<
  TestCandidate["status"],
  { label: string; variant: "status-pending" | "status-passed" | "status-failed" }
> = {
  pending: { label: "pending", variant: "status-pending" },
  accepted: { label: "accepted", variant: "status-passed" },
  rejected: { label: "rejected", variant: "status-failed" },
};

interface TestCandidateRowProps {
  candidate: TestCandidate;
}

export function TestCandidateRow({ candidate }: TestCandidateRowProps) {
  const [expanded, setExpanded] = useState(false);
  const statusBadge = STATUS_BADGE[candidate.status];

  return (
    <div className="border border-border-dim bg-surface-raised">
      <div className="flex items-start gap-3 px-4 py-3">
        <Badge variant={statusBadge.variant} className="mt-0.5 shrink-0">
          {statusBadge.label}
        </Badge>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {candidate.acceptedTestCase != null ? (
              <AppLink
                to="/app/$appSlug/tests/$testSlug"
                params={{ testSlug: candidate.acceptedTestCase.slug }}
                className="min-w-0 truncate font-mono text-sm text-text-primary hover:underline"
              >
                {candidate.acceptedTestCase.name}
              </AppLink>
            ) : (
              <span className="min-w-0 truncate font-mono text-sm text-text-primary">{candidate.name}</span>
            )}
          </div>
          <p className="mt-1 line-clamp-2 text-xs text-text-tertiary">{candidate.instruction}</p>
        </div>
        {candidate.reasoning.trim().length > 0 && (
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
          <p className="text-xs leading-relaxed text-text-secondary">{candidate.reasoning}</p>
        </div>
      )}
    </div>
  );
}
