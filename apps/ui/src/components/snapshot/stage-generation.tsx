import { GenerationCard } from "components/generation/generation-card";
import type { DiffsJob } from "./diffs-timeline-types";
import { RefinementLoopBlock } from "./refinement-loop-block";
import type { RefinementLoop } from "./refinement-types";
import { StageEmpty } from "./stage-empty";

interface StageGenerationProps {
  job: DiffsJob;
  refinementLoop: RefinementLoop | undefined;
  snapshotId: string;
}

export function StageGeneration({ job, refinementLoop, snapshotId }: StageGenerationProps) {
  if (refinementLoop !== undefined) {
    return <RefinementLoopBlock loop={refinementLoop} snapshotId={snapshotId} />;
  }

  const items: Array<{ id: string; status: GenerationCardStatusInput; testCaseName: string }> = [];

  for (const t of job.affectedTests) {
    if (t.generation == null) continue;
    items.push({ id: t.generation.id, status: t.generation.status, testCaseName: t.testCase.name });
  }
  for (const c of job.testCandidates) {
    if (c.generation == null) continue;
    items.push({
      id: c.generation.id,
      status: c.generation.status,
      testCaseName: c.acceptedTestCase?.name ?? c.name,
    });
  }

  if (items.length === 0) {
    return <StageEmpty message="No generations spawned" />;
  }

  return (
    <div className="flex flex-col gap-2">
      {items.map((g) => (
        <GenerationCard key={g.id} generationId={g.id} testCaseName={g.testCaseName} status={g.status} />
      ))}
    </div>
  );
}

type GenerationCardStatusInput = React.ComponentProps<typeof GenerationCard>["status"];
