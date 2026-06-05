import { Badge, Tooltip, TooltipContent, TooltipTrigger } from "@autonoma/blacklight";
import { Link } from "@tanstack/react-router";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";
import { useCurrentApplication } from "routes/_blacklight/_app-shell/-use-current-application";
import type { TestCandidate } from "./diffs-timeline-types";
import { PipelineIds } from "./pipeline-ids";

const STATUS_BADGE: Record<
  TestCandidate["status"],
  { label: string; variant: "status-pending" | "status-passed" | "status-failed"; hint: string }
> = {
  pending: {
    label: "pending",
    variant: "status-pending",
    hint: "The proposal has not been decided yet.",
  },
  accepted: {
    label: "accepted",
    variant: "status-passed",
    hint: "The proposed candidate was added to the test suite.",
  },
  rejected: {
    label: "rejected",
    variant: "status-failed",
    hint: "The proposed candidate was discarded.",
  },
};

interface TestCandidateRowProps {
  candidate: TestCandidate;
  prNumber?: number;
}

export function TestCandidateRow({ candidate, prNumber }: TestCandidateRowProps) {
  const statusBadge = STATUS_BADGE[candidate.status];
  const app = useCurrentApplication();

  const instruction = candidate.instruction.trim();
  const reasoning = candidate.reasoning.trim();
  const generationReview = candidate.generation?.reviewReasoning?.trim() ?? "";
  const hasDetails = instruction.length > 0 || reasoning.length > 0 || generationReview.length > 0;

  return (
    <div className="border border-border-dim bg-surface-raised">
      <div className="flex items-start gap-3 px-4 py-3">
        <Tooltip>
          <TooltipTrigger
            render={
              <Badge variant={statusBadge.variant} className="mt-0.5 shrink-0">
                {statusBadge.label}
              </Badge>
            }
          />
          <TooltipContent>{statusBadge.hint}</TooltipContent>
        </Tooltip>
        <div className="min-w-0 flex-1">
          {candidate.acceptedTestCase != null ? (
            prNumber != null ? (
              <Link
                to="/app/$appSlug/pull-requests/$prNumber/suite"
                params={{ appSlug: app.slug, prNumber }}
                search={{ testSlug: candidate.acceptedTestCase.slug }}
                className="min-w-0 truncate font-mono text-sm text-text-primary hover:underline"
              >
                {candidate.acceptedTestCase.name}
              </Link>
            ) : (
              <AppLink
                to="/app/$appSlug/tests/$testSlug"
                params={{ testSlug: candidate.acceptedTestCase.slug }}
                className="min-w-0 truncate font-mono text-sm text-text-primary hover:underline"
              >
                {candidate.acceptedTestCase.name}
              </AppLink>
            )
          ) : (
            <span className="min-w-0 truncate font-mono text-sm text-text-primary">{candidate.name}</span>
          )}
        </div>
      </div>
      <PipelineIds
        ids={[
          { label: "candidate", value: candidate.id },
          { label: "test", value: candidate.acceptedTestCase?.id },
          { label: "generation", value: candidate.generation?.id },
          { label: "run", value: candidate.run?.id },
        ]}
        className="border-t border-border-dim bg-surface-base px-4 py-2"
      />
      {hasDetails && (
        <div className="flex flex-col gap-3 border-t border-border-dim bg-surface-base px-4 py-3">
          {instruction.length > 0 && <ReasoningSection label="Proposal" content={instruction} />}
          {reasoning.length > 0 && <ReasoningSection label="Reasoning" content={reasoning} />}
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
