import { Badge, Button } from "@autonoma/blacklight";
import { XIcon } from "@phosphor-icons/react/X";
import { CHANGE_BADGE_VARIANTS } from "components/snapshot/snapshot-change-row";
import { useDiscardChange, useEditSession } from "lib/query/snapshot-edit.queries";
import type { RouterOutputs } from "lib/trpc";
import { EditTab } from "../-edit-tab-content";

type EditSession = RouterOutputs["snapshotEdit"]["get"];
type SnapshotChange = EditSession["changes"][number];

export function EditChangesTab({ branchId }: { branchId: string }) {
  const { data: session } = useEditSession(branchId);
  const changes = session.changes;
  if (changes.length === 0) {
    return (
      <EditTab className="flex justify-center items-center w-full">
        <div className="flex flex-col items-center justify-center gap-2 py-16 text-text-tertiary">
          <p className="text-sm">No changes yet</p>
          <p className="text-2xs">Add, remove, or update tests to see changes here.</p>
        </div>
      </EditTab>
    );
  }

  return (
    <EditTab className="flex flex-col justify-start w-full">
      {changes.map((change) => (
        <ChangeRow key={change.testCaseId} branchId={branchId} change={change} />
      ))}
    </EditTab>
  );
}

function ChangeRow({ branchId, change }: { branchId: string; change: SnapshotChange }) {
  const discardChange = useDiscardChange();

  return (
    <div className={"flex items-center justify-between px-5 py-4 bg-surface-raised border-1 border-border-dim"}>
      <div className="flex items-center gap-3">
        <Badge variant={CHANGE_BADGE_VARIANTS[change.type]}>{change.type}</Badge>
        <span className="font-mono text-sm text-text-primary">{change.testCaseName}</span>
      </div>
      <Button
        variant="ghost"
        size="icon-xs"
        className="text-text-tertiary hover:text-status-critical"
        onClick={() => discardChange.mutate({ branchId, testCaseId: change.testCaseId })}
        disabled={discardChange.isPending}
      >
        <XIcon size={14} />
      </Button>
    </div>
  );
}
