import { SnapshotChangeRow, type SnapshotChangeType } from "./snapshot-change-row";
import { StageEmpty } from "./stage-empty";

interface StageFinalizationProps {
  changes: Array<{ type: SnapshotChangeType; testCaseId: string; testCaseName: string }>;
}

export function StageFinalization({ changes }: StageFinalizationProps) {
  if (changes.length === 0) {
    return <StageEmpty message="No test suite changes" />;
  }

  return (
    <ul className="flex flex-col gap-1.5">
      {changes.map((change) => (
        <li key={change.testCaseId}>
          <SnapshotChangeRow type={change.type} testCaseName={change.testCaseName} />
        </li>
      ))}
    </ul>
  );
}
