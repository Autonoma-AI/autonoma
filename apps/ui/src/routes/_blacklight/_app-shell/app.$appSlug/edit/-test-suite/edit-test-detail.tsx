import {
  Badge,
  Button,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  stepInstruction as getStepInstruction,
} from "@autonoma/blacklight";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react/ArrowsClockwise";
import { LightningIcon } from "@phosphor-icons/react/Lightning";
import { PencilSimpleIcon } from "@phosphor-icons/react/PencilSimple";
import { StackIcon } from "@phosphor-icons/react/Stack";
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

  const hasSteps = testCase.steps != null;
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
                {hasSteps ? (
                  <>
                    <ArrowsClockwiseIcon size={14} />
                    Re-generate
                  </>
                ) : (
                  <>
                    <LightningIcon size={14} />
                    Generate
                  </>
                )}
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

      <Tabs defaultValue="plan" className="flex min-h-0 flex-1 flex-col">
        <TabsList className="shrink-0">
          <TabsTrigger value="plan">Plan</TabsTrigger>
          <TabsTrigger value="steps">Steps</TabsTrigger>
        </TabsList>

        <TabsContent value="plan" className="mt-4 min-h-0 flex-1 overflow-y-auto">
          <TestPlanView plan={testCase.plan} />
        </TabsContent>

        <TabsContent value="steps" className="mt-4 min-h-0 flex-1 flex flex-col overflow-y-auto">
          <TestStepsView steps={testCase.steps} />
        </TabsContent>
      </Tabs>
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

// ─── Steps Tab ───────────────────────────────────────────────────────────────

interface StepData {
  id: string;
  order: number;
  interaction: string;
  params: unknown;
  screenshotBefore: string | null | undefined;
  screenshotAfter: string | null | undefined;
}

export function TestStepsView({ steps }: { steps: { list: unknown } | null }) {
  const stepList = steps?.list as StepData[] | undefined;

  if (stepList == null || stepList.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 border border-dashed border-border-mid py-14 text-center">
        <StackIcon size={24} className="text-text-tertiary" />
        <p className="text-sm text-text-tertiary">No steps defined</p>
      </div>
    );
  }

  return (
    <div>
      {stepList.map((step, i) => {
        const screenshot = step.screenshotBefore ?? step.screenshotAfter;
        const instruction = getStepInstruction({ interaction: step.interaction, params: step.params });
        const isLast = i === stepList.length - 1;

        return (
          <div key={step.id} className="flex gap-4">
            <div className="mt-0.5 flex flex-col items-center">
              <div className="flex size-6 shrink-0 items-center justify-center border border-border-mid bg-surface-base">
                <span className="font-mono text-3xs text-text-tertiary">{step.order}</span>
              </div>
              {!isLast && <div className="mt-1 h-full w-px bg-border-mid" />}
            </div>

            <div className="mb-3 flex-1 overflow-hidden border border-border-mid bg-surface-raised">
              <div className="flex">
                {screenshot != null && (
                  <div className="relative w-52 shrink-0 overflow-hidden border-r border-border-mid bg-surface-base">
                    <img src={screenshot} alt={`Step ${step.order}`} className="h-full w-full object-cover" />
                  </div>
                )}
                <div className="flex flex-1 flex-col justify-center gap-2 px-4 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-medium leading-snug text-text-primary">{instruction}</p>
                    <span className="shrink-0 font-mono text-2xs font-medium text-text-tertiary">#{step.order}</span>
                  </div>
                  <Badge variant="outline" className="w-fit font-mono text-3xs uppercase">
                    {step.interaction}
                  </Badge>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
