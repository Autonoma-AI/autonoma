import { Button, Label, cn } from "@autonoma/blacklight";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { PlayIcon } from "@phosphor-icons/react/Play";
import { RobotIcon } from "@phosphor-icons/react/Robot";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { PreviewLogsTabs } from "components/build-logs/preview-logs-tabs";
import { AGENT_DIALOG_DESCRIPTION, ConnectAgentDialog } from "components/connect-agent-dialog";
import { NameTheMcpNote } from "components/name-the-mcp-note";
import { type DryRunOutcome, formatDryRunError } from "lib/format-dry-run-error";
import { AGENT_INSTRUCTIONS } from "lib/onboarding/agent-instructions";
import { useOnboardingScenarios, useRunScenarioDryRun, useSdkDryRunTargets } from "lib/onboarding/onboarding-api";
import { useState } from "react";
import { Code } from "./prose";
import { buildPreviewLogTarget, formatTargetLabel, targetAvailabilityNote } from "./targets";

export interface DryRunStepBodyProps {
  applicationId: string;
  selectedTargetId: string | undefined;
}

export function DryRunStepBody({ applicationId, selectedTargetId }: DryRunStepBodyProps) {
  const { data: scenarios } = useOnboardingScenarios(applicationId);
  const { data: targets } = useSdkDryRunTargets(applicationId);
  const runDryRun = useRunScenarioDryRun();
  const [results, setResults] = useState<Record<string, DryRunOutcome>>({});
  const [isRunning, setIsRunning] = useState(false);
  const [logsExpanded, setLogsExpanded] = useState(true);
  // Owned here rather than lifted from the SDK step: that step's dialog lives in a
  // sibling component, and this one carries its own copy so the step stays movable.
  const [agentDialogOpen, setAgentDialogOpen] = useState(false);

  // The target is shared with the SDK step through the URL, so the dry run hits
  // exactly the preview validated there.
  const list = scenarios ?? [];
  const selectedTarget = targets.targets.find((t) => t.id === selectedTargetId);
  const selectedTargetNote = selectedTarget != null ? targetAvailabilityNote(selectedTarget.availability) : undefined;
  const previewLogTarget = buildPreviewLogTarget(selectedTarget);
  const anyFailed = Object.values(results).some((result) => result.success === false);

  if (list.length === 0) {
    return (
      <p className="text-sm text-text-secondary">
        No scenarios yet. They arrive with the planner's <Code>recipe.json</Code> - go back to the upload step and run
        the CLI.
      </p>
    );
  }

  async function runAll() {
    if (selectedTargetId == null) return;
    setIsRunning(true);
    setResults({});
    for (const scenario of list) {
      try {
        const result = await new Promise<DryRunOutcome>((resolve, reject) => {
          runDryRun.mutate(
            { applicationId, scenarioId: scenario.id, targetId: selectedTargetId },
            {
              onSuccess: (data) =>
                resolve({ success: data.success, phase: data.phase, error: formatDryRunError(data.error) }),
              onError: (err) => reject(err),
            },
          );
        });
        setResults((prev) => ({ ...prev, [scenario.id]: result }));
      } catch (err) {
        // Keep the reason on the row. A dry run that throws never reaches the SDK, so it
        // leaves no instance and no preview logs - the toast carrying this message is the
        // only other place it appears, and it is gone in seconds.
        setResults((prev) => ({ ...prev, [scenario.id]: { success: false, error: formatDryRunError(err) } }));
      }
    }
    setIsRunning(false);
  }

  return (
    <div className="flex flex-col gap-3">
      {selectedTarget != null && (
        <div className="flex flex-col gap-1.5">
          <Label>Running against</Label>
          <div className="flex items-center gap-2 text-sm text-text-primary">
            <span className="font-medium">{formatTargetLabel(selectedTarget)}</span>
            {selectedTargetNote != null && <span className="text-text-secondary">- {selectedTargetNote}</span>}
          </div>
          {selectedTarget.sdkUrl != null && (
            <p className="font-mono text-2xs text-text-secondary">SDK endpoint: {selectedTarget.sdkUrl}</p>
          )}
          <p className="text-2xs text-text-secondary">
            The target you validated on the SDK step. Go Back to run against a different preview.
          </p>
        </div>
      )}
      {selectedTarget == null && (
        <p className="text-sm text-text-secondary">
          No ready preview to run against. Go Back to the SDK step to deploy or select one.
        </p>
      )}
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-text-primary">
          Dry run {list.length} scenario{list.length === 1 ? "" : "s"}
        </span>
        <div className="flex items-center gap-1.5">
          {/* A failed dry run is usually a recipe or SDK-handler fix, and the agent can do both:
              it reads the recipe, tries edits against the live SDK, and fixes the handler in the repo. */}
          <Button
            variant={anyFailed ? "accent" : "ghost"}
            size="sm"
            className="gap-1.5"
            onClick={() => setAgentDialogOpen(true)}
          >
            <RobotIcon size={14} weight="bold" />
            {anyFailed ? "Fix with coding agent" : "Debug with coding agent"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => void runAll()}
            disabled={isRunning || selectedTarget?.availability !== "ready"}
          >
            <PlayIcon size={14} weight="bold" />
            {isRunning ? "Running..." : "Run dry run"}
          </Button>
        </div>
      </div>

      <ConnectAgentDialog
        open={agentDialogOpen}
        onOpenChange={setAgentDialogOpen}
        applicationId={applicationId}
        title="Debug with a coding agent"
        description={AGENT_DIALOG_DESCRIPTION}
        instruction={AGENT_INSTRUCTIONS.dryRun}
        capabilities={
          <>
            <NameTheMcpNote /> It can read the recipe, try edits against your deployed SDK without saving them, and fix
            the SDK handler in your repo.
          </>
        }
      />
      <div className="flex flex-col gap-2">
        {list.map((scenario) => {
          const result = results[scenario.id];
          return (
            <div key={scenario.id} className="flex flex-col gap-1">
              <div className="flex items-center gap-2.5 font-mono text-2xs">
                {result == null ? (
                  <span className="size-3.5 shrink-0 rounded-full border border-border-dim" />
                ) : result.success ? (
                  <CheckCircleIcon size={14} weight="fill" className="shrink-0 text-status-success" />
                ) : (
                  <WarningCircleIcon size={14} weight="fill" className="shrink-0 text-status-critical" />
                )}
                <span className={cn(result?.success === false && "text-status-critical")}>
                  {scenario.name}
                  {result?.success === false && result.phase != null && ` - failed during ${result.phase}`}
                </span>
              </div>
              {result?.success === false && result.error != null && result.error !== "" && (
                <p className="ml-6 whitespace-pre-wrap break-words font-mono text-3xs text-status-critical/90">
                  {result.error}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {anyFailed && previewLogTarget != null && (
        <div className="flex flex-col gap-1.5 border-t border-border-dim pt-3">
          <button
            type="button"
            onClick={() => setLogsExpanded((prev) => !prev)}
            aria-expanded={logsExpanded}
            className="flex w-fit items-center gap-1.5"
          >
            <CaretDownIcon
              size={12}
              className={cn("text-text-secondary transition-transform", logsExpanded ? "" : "-rotate-90")}
            />
            <span className="font-mono text-2xs font-medium uppercase tracking-widest text-text-secondary">
              Preview runtime logs
            </span>
          </button>
          {logsExpanded && (
            <>
              <p className="text-2xs text-text-secondary">
                Live output from <span className="font-medium">{selectedTarget?.label}</span>. A dry run fails during{" "}
                <Code>up</Code> when the SDK endpoint errors provisioning data - the stack trace lands here if your
                handler logs it.
              </p>
              <PreviewLogsTabs
                owner={previewLogTarget.owner}
                repo={previewLogTarget.repo}
                pr={previewLogTarget.pr}
                app={previewLogTarget.app}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}
