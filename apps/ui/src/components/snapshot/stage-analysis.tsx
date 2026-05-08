import { AffectedTestRow } from "./affected-test-row";
import type { DiffsJob } from "./diffs-timeline-types";
import { ReasoningBlock } from "./reasoning-block";
import { StageEmpty } from "./stage-empty";
import { TestCandidateRow } from "./test-candidate-row";

interface StageAnalysisProps {
  job: DiffsJob;
}

export function StageAnalysis({ job }: StageAnalysisProps) {
  const hasAffected = job.affectedTests.length > 0;
  const hasCandidates = job.testCandidates.length > 0;

  return (
    <div className="flex flex-col gap-4">
      {job.analysisReasoning != null && <ReasoningBlock label="Analysis reasoning" content={job.analysisReasoning} />}

      <div className="flex flex-col gap-2">
        <SectionHeader title="Affected tests" count={job.affectedTests.length} />
        {hasAffected ? (
          <div className="flex flex-col gap-1.5">
            {job.affectedTests.map((test) => (
              <AffectedTestRow key={test.testCase.id} test={test} />
            ))}
          </div>
        ) : (
          <StageEmpty message="No affected tests detected" />
        )}
      </div>

      <div className="flex flex-col gap-2">
        <SectionHeader title="Proposed new tests" count={job.testCandidates.length} />
        {hasCandidates ? (
          <div className="flex flex-col gap-1.5">
            {job.testCandidates.map((candidate) => (
              <TestCandidateRow key={candidate.id} candidate={candidate} />
            ))}
          </div>
        ) : (
          <StageEmpty message="No new test candidates proposed" />
        )}
      </div>
    </div>
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
