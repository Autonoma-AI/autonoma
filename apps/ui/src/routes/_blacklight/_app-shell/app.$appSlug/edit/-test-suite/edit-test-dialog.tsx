import {
  Button,
  Dialog,
  DialogBackdrop,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Textarea,
} from "@autonoma/blacklight";
import { useScenariosForApp } from "lib/query/scenarios.queries";
import { useUpdateTestInEdit } from "lib/query/snapshot-edit.queries";
import { Suspense, useState } from "react";
import { useCurrentApplication } from "../../../-use-current-application";

const NO_SCENARIO_VALUE = "__none__";

interface EditTestDialogProps {
  snapshotId: string;
  testCaseId: string;
  currentPlan: string;
  currentScenarioId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EditTestDialog({
  snapshotId,
  testCaseId,
  currentPlan,
  currentScenarioId,
  open,
  onOpenChange,
}: EditTestDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogBackdrop />
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit test</DialogTitle>
          <DialogDescription>Update the test plan or change its scenario.</DialogDescription>
        </DialogHeader>
        <Suspense fallback={<Skeleton className="mx-6 mb-6 h-64 w-auto" />}>
          <EditTestFormContent
            snapshotId={snapshotId}
            testCaseId={testCaseId}
            currentPlan={currentPlan}
            currentScenarioId={currentScenarioId}
            onClose={() => onOpenChange(false)}
          />
        </Suspense>
      </DialogContent>
    </Dialog>
  );
}

// --- Form ---

interface EditTestFormContentProps {
  snapshotId: string;
  testCaseId: string;
  currentPlan: string;
  currentScenarioId?: string;
  onClose: () => void;
}

function EditTestFormContent({
  snapshotId,
  testCaseId,
  currentPlan,
  currentScenarioId,
  onClose,
}: EditTestFormContentProps) {
  const currentApp = useCurrentApplication();
  const { data: scenarios } = useScenariosForApp(currentApp.id);

  const [plan, setPlan] = useState(currentPlan);
  const [scenarioId, setScenarioId] = useState(currentScenarioId ?? "");

  const updateTest = useUpdateTestInEdit();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const selectedScenarioId = scenarioId !== "" ? scenarioId : undefined;

    updateTest.mutate({ snapshotId, testCaseId, plan, scenarioId: selectedScenarioId }, { onSuccess: () => onClose() });
  }

  const hasChanges = plan !== currentPlan || (scenarioId || undefined) !== currentScenarioId;
  const isValid = plan.trim() !== "" && hasChanges;

  return (
    <form onSubmit={handleSubmit}>
      <DialogBody className="flex flex-col gap-4">
        {scenarios != null && scenarios.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <Label>Scenario</Label>
            <Select<string>
              value={scenarioId === "" ? NO_SCENARIO_VALUE : scenarioId}
              onValueChange={(value) => {
                setScenarioId(value === NO_SCENARIO_VALUE || value == null ? "" : value);
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_SCENARIO_VALUE}>None</SelectItem>
                {scenarios.map((scenario) => (
                  <SelectItem key={scenario.id} value={scenario.id}>
                    {scenario.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="edit-test-plan">
            Plan <span className="text-status-critical">*</span>
          </Label>
          <Textarea
            id="edit-test-plan"
            placeholder="Write your test plan in markdown..."
            value={plan}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setPlan(e.target.value)}
            className="min-h-48 resize-none"
          />
        </div>
      </DialogBody>

      <DialogFooter>
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={!isValid || updateTest.isPending} size="sm">
          {updateTest.isPending ? "Saving..." : "Save"}
        </Button>
      </DialogFooter>
    </form>
  );
}
