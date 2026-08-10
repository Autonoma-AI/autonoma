import { useEditSession } from "lib/query/snapshot-edit.queries";
import { useState } from "react";
import { EditTab } from "../-edit-tab-content";
import { AddTestDialog } from "./add-test-dialog";
import { EditTestDetail, EditTestDetailEmpty } from "./edit-test-detail";
import { EditTreePanel } from "./edit-tree";

// ─── Test Suite Tab ──────────────────────────────────────────────────────────
export function TestSuiteTab({ snapshotId }: { snapshotId: string }) {
  const { data: session } = useEditSession(snapshotId);
  const [selectedTestId, setSelectedTestId] = useState<string | undefined>();
  const [addDialogOpen, setAddDialogOpen] = useState(false);

  const changesByTestCaseId = new Map(session.changes.map((c) => [c.testCaseId, c.type] as const));
  const runByTestCaseId = new Map(session.runs.map((run) => [run.testCaseId, run] as const));
  const selectedTest = session.testSuite.testCases.find((tc) => tc.id === selectedTestId);

  return (
    <>
      <EditTab>
        <div className="w-72">
          <div className="h-full border border-border-mid bg-surface-raised">
            <EditTreePanel
              testCases={session.testSuite.testCases}
              selectedTestId={selectedTestId}
              onSelectTest={setSelectedTestId}
              onOpenAddDialog={() => setAddDialogOpen(true)}
              changesByTestCaseId={changesByTestCaseId}
            />
          </div>
        </div>

        <div className="min-w-0 flex-1 border border-border-mid bg-surface-raised">
          {selectedTest != null ? (
            <EditTestDetail
              key={selectedTest.id}
              snapshotId={snapshotId}
              testCase={selectedTest}
              run={runByTestCaseId.get(selectedTest.id)}
            />
          ) : (
            <EditTestDetailEmpty />
          )}
        </div>
      </EditTab>

      <AddTestDialog snapshotId={snapshotId} open={addDialogOpen} onOpenChange={setAddDialogOpen} />
    </>
  );
}
