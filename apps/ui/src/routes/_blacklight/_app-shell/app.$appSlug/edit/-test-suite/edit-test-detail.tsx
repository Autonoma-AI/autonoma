import { Badge, Button } from "@autonoma/blacklight";
import { LightningIcon } from "@phosphor-icons/react/Lightning";
import { PencilSimpleIcon } from "@phosphor-icons/react/PencilSimple";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { ReasoningMarkdown } from "components/snapshot/reasoning-block";
import { useRegenerateSteps, useRemoveTestFromEdit } from "lib/query/snapshot-edit.queries";
import type { RouterOutputs } from "lib/trpc";
import { useState } from "react";
import { EditTestDialog } from "./edit-test-dialog";

type EditSession = RouterOutputs["snapshotEdit"]["get"];
type TestCaseEntry = EditSession["testSuite"]["testCases"][number];
type GenerationEntry = EditSession["generationSummary"][number];

interface EditTestDetailProps {
  branchId: string;
  testCase: TestCaseEntry;
  generation?: GenerationEntry;
}

export function EditTestDetail({ branchId, testCase, generation }: EditTestDetailProps) {
  const removeTest = useRemoveTestFromEdit();
  const regenerateSteps = useRegenerateSteps();
  const [showEditDialog, setShowEditDialog] = useState(false);

  const isGenerating =
    generation != null &&
    (generation.status === "pending" || generation.status === "queued" || generation.status === "running");

  return (
    <div className="flex h-full flex-col overflow-y-auto p-6">
      <div className="mb-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-xl font-medium tracking-tight text-text-primary">{testCase.name}</h2>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {generation != null && <GenerationBadge status={generation.status} />}
            {!isGenerating && (
              <Button
                variant="outline"
                size="xs"
                onClick={() => regenerateSteps.mutate({ branchId, testCaseId: testCase.id })}
                disabled={regenerateSteps.isPending}
              >
                <LightningIcon size={14} />
                Generate
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-text-tertiary hover:text-text-primary"
              onClick={() => setShowEditDialog(true)}
            >
              <PencilSimpleIcon size={14} />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-text-tertiary hover:text-status-critical"
              onClick={() => removeTest.mutate({ branchId, testCaseId: testCase.id })}
              disabled={removeTest.isPending}
            >
              <TrashIcon size={14} />
            </Button>
          </div>
        </div>
      </div>

      <EditTestDialog
        branchId={branchId}
        testCaseId={testCase.id}
        currentPlan={testCase.plan?.prompt ?? ""}
        currentScenarioId={testCase.plan?.scenarioId ?? undefined}
        open={showEditDialog}
        onOpenChange={setShowEditDialog}
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <TestPlanView plan={testCase.plan} />
      </div>
    </div>
  );
}

// ─── Empty State ─────────────────────────────────────────────────────────────

export function EditTestDetailEmpty() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-text-tertiary">
      <p className="text-sm">Select a test to view details</p>
    </div>
  );
}

// ─── Generation Badge ────────────────────────────────────────────────────────

function generationBadgeVariant(
  status: string,
): "status-passed" | "status-failed" | "status-running" | "status-pending" | "outline" {
  switch (status) {
    case "success":
      return "status-passed";
    case "failed":
      return "status-failed";
    case "running":
      return "status-running";
    case "pending":
    case "queued":
      return "status-pending";
    default:
      return "outline";
  }
}

function GenerationBadge({ status }: { status: string }) {
  return <Badge variant={generationBadgeVariant(status)}>{status}</Badge>;
}

// ─── Plan Tab ────────────────────────────────────────────────────────────────

export function TestPlanView({ plan }: { plan: { prompt: string } | null }) {
  if (plan == null) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-12 text-text-tertiary">
        <p className="text-sm">No plan defined</p>
      </div>
    );
  }

  return (
    <div className="border border-border-mid bg-surface-base p-4">
      <ReasoningMarkdown content={plan.prompt} />
    </div>
  );
}
