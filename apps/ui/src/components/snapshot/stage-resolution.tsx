import { Badge } from "@autonoma/blacklight";
import { AffectedTestRow } from "./affected-test-row";
import type { AffectedTest, DiffsJob } from "./diffs-timeline-types";
import { ReasoningBlock } from "./reasoning-block";
import { StageEmpty } from "./stage-empty";
import { TestCandidateRow } from "./test-candidate-row";

type GenerationStatus = NonNullable<AffectedTest["generation"]>["status"];

const GENERATION_STATUS_BADGE: Record<
  GenerationStatus,
  "status-pending" | "status-running" | "status-passed" | "status-failed"
> = {
  pending: "status-pending",
  queued: "status-pending",
  running: "status-running",
  success: "status-passed",
  failed: "status-failed",
};

interface StageResolutionProps {
  job: DiffsJob;
}

export function StageResolution({ job }: StageResolutionProps) {
  const queuedForRegeneration = job.affectedTests.filter((t) => t.generation != null);
  const decidedCandidates = job.testCandidates.filter((c) => c.status !== "pending");

  return (
    <div className="flex flex-col gap-4">
      {job.resolutionReasoning != null && (
        <ReasoningBlock label="Resolution reasoning" content={job.resolutionReasoning} />
      )}

      <div className="flex flex-col gap-2">
        <SectionHeader title="Queued for regeneration" count={queuedForRegeneration.length} />
        {queuedForRegeneration.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            {queuedForRegeneration.map((test) => (
              <AffectedTestRow
                key={test.testCase.id}
                test={test}
                showReasoning={false}
                nameLink={{ kind: "generation", generationId: test.generation!.id }}
                rightSlot={<GenerationStatusBadge generation={test.generation!} />}
              />
            ))}
          </div>
        ) : (
          <StageEmpty message="No tests queued for regeneration" />
        )}
      </div>

      <div className="flex flex-col gap-2">
        <SectionHeader title="Candidate decisions" count={decidedCandidates.length} />
        {decidedCandidates.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            {decidedCandidates.map((candidate) => (
              <TestCandidateRow key={candidate.id} candidate={candidate} />
            ))}
          </div>
        ) : (
          <StageEmpty message="No candidate decisions yet" />
        )}
      </div>
    </div>
  );
}

function GenerationStatusBadge({ generation }: { generation: NonNullable<AffectedTest["generation"]> }) {
  return (
    <Badge variant={GENERATION_STATUS_BADGE[generation.status]} className="shrink-0">
      {generation.status}
    </Badge>
  );
}

function SectionHeader({ title, count }: { title: string; count: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-2xs uppercase tracking-widest text-text-tertiary">{title}</span>
      <span className="font-mono text-2xs text-text-tertiary">({count})</span>
    </div>
  );
}
