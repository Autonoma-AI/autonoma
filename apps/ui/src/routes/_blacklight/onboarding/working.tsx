import { Skeleton, cn } from "@autonoma/blacklight";
import { Check } from "@phosphor-icons/react/Check";
import { CircleNotch } from "@phosphor-icons/react/CircleNotch";
import { File } from "@phosphor-icons/react/File";
import { FileArrowUp } from "@phosphor-icons/react/FileArrowUp";
import { TerminalWindowIcon } from "@phosphor-icons/react/TerminalWindow";
import { WarningCircle } from "@phosphor-icons/react/WarningCircle";
import { Navigate, createFileRoute, useNavigate } from "@tanstack/react-router";
import { sounds } from "lib/onboarding/sounds";
import { usePollApplicationSetup } from "lib/query/app-generations.queries";
import { toastManager } from "lib/toast-manager";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { DocLink } from "./-components/doc-link";
import { OnboardingPageHeader } from "./-components/onboarding-page-header";

const SETUP_STEP_NAMES = ["Knowledge Base", "Scenarios", "E2E Tests", "Environment Factory"] as const;

export const Route = createFileRoute("/_blacklight/onboarding/working")({
  component: () => <Navigate to="/onboarding" search={{ step: "working", appId: undefined }} />,
});

interface SetupEvent {
  id: string;
  type: string;
  data: Record<string, unknown>;
  createdAt: Date;
}

function getSetupEventIcon(type: string) {
  switch (type) {
    case "file.read":
      return <File size={12} className="text-text-tertiary" />;
    case "file.created":
      return <FileArrowUp size={12} className="text-primary-ink" />;
    case "error":
      return <WarningCircle size={12} className="text-status-critical" />;
    default:
      return null;
  }
}

function getSetupEventMessage(event: SetupEvent) {
  const data = event.data;
  switch (event.type) {
    case "step.started":
      return `Starting: ${data.name as string}`;
    case "step.completed":
      return `Completed: ${data.name as string}`;
    case "file.read":
      return `Reading ${data.filePath as string}`;
    case "file.created":
      return `Created ${data.filePath as string}`;
    case "log":
      return data.message as string;
    case "error":
      return data.message as string;
    default:
      return event.type;
  }
}

function StepIndicator({ step, currentStep, status }: { step: number; currentStep: number; status: string }) {
  const isCompleted = status === "completed" || (status === "running" && step < currentStep);
  const isActive = status === "running" && step === currentStep;
  const isFailed = status === "failed" && step === currentStep;

  return (
    <div className="flex items-center gap-3">
      <div
        className={cn(
          "flex size-7 items-center justify-center rounded-full border transition-all",
          isCompleted && "border-primary-ink bg-primary-ink",
          isActive && "border-primary-ink",
          isFailed && "border-status-critical",
          !isCompleted && !isActive && !isFailed && "border-border-dim",
        )}
      >
        {isCompleted ? (
          <Check size={14} weight="bold" className="text-surface-void" />
        ) : isActive ? (
          <CircleNotch size={14} className="animate-spin text-primary-ink" />
        ) : isFailed ? (
          <WarningCircle size={14} className="text-status-critical" />
        ) : (
          <span className="font-mono text-3xs text-text-tertiary">{step + 1}</span>
        )}
      </div>
      <span
        className={cn(
          "text-sm font-medium transition-colors",
          isCompleted && "text-text-primary",
          isActive && "text-primary-ink",
          isFailed && "text-status-critical",
          !isCompleted && !isActive && !isFailed && "text-text-tertiary",
        )}
      >
        {SETUP_STEP_NAMES[step]}
      </span>
    </div>
  );
}

function SetupProgress({ applicationId }: { applicationId: string }) {
  const navigate = useNavigate();
  const { data: setup } = usePollApplicationSetup(applicationId);
  const consoleRef = useRef<HTMLDivElement>(null);
  const completedFiredRef = useRef(false);
  const lastNotifiedStepRef = useRef(-1);
  const [waitingForConfirmation, setWaitingForConfirmation] = useState(false);

  const events = useMemo(() => (setup?.events ?? []) as SetupEvent[], [setup?.events]);
  const currentStep = setup?.currentStep ?? 0;
  const status = setup?.status ?? "running";
  const isCompleted = status === "completed";
  const isFailed = status === "failed";

  // Filter to display events (file.read, file.created, log, error)
  const displayEvents = events.filter(
    (e) => e.type === "file.read" || e.type === "file.created" || e.type === "log" || e.type === "error",
  );

  // Auto-scroll when new events arrive
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll triggered by event count change
  useEffect(() => {
    if (consoleRef.current != null) {
      consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
    }
  }, [displayEvents.length]);

  // Detect when a step completes and the plugin is waiting for user confirmation
  useEffect(() => {
    if (isCompleted || isFailed) {
      setWaitingForConfirmation(false);
      return;
    }

    // Check if the latest event is a step.completed - plugin is waiting for user input
    const latestStepCompleted = [...events].reverse().find((e) => e.type === "step.completed");
    if (latestStepCompleted == null) return;

    const completedStepIndex = (latestStepCompleted.data as { step?: number }).step ?? -1;
    if (completedStepIndex <= lastNotifiedStepRef.current) return;

    // Check if we're still on the same step (no new step.started after this completion)
    const latestStepStarted = [...events].reverse().find((e) => e.type === "step.started");
    const startedStepIndex =
      latestStepStarted != null ? ((latestStepStarted.data as { step?: number }).step ?? -1) : -1;
    const isWaiting = completedStepIndex >= startedStepIndex;

    if (isWaiting && completedStepIndex < SETUP_STEP_NAMES.length - 1) {
      lastNotifiedStepRef.current = completedStepIndex;
      setWaitingForConfirmation(true);
      sounds.attention();
      toastManager.add({
        title: `${SETUP_STEP_NAMES[completedStepIndex]} completed`,
        description: "Switch to your terminal and confirm to continue to the next step.",
        type: "info",
      });
    } else {
      setWaitingForConfirmation(false);
    }
  }, [events, isCompleted, isFailed]);

  // Clear waiting state when a new step starts
  // biome-ignore lint/correctness/useExhaustiveDependencies: clear waiting on step change
  useEffect(() => {
    if (currentStep > lastNotifiedStepRef.current) {
      setWaitingForConfirmation(false);
    }
  }, [currentStep]);

  useEffect(() => {
    if (isCompleted && !completedFiredRef.current) {
      completedFiredRef.current = true;
      sounds.success();
      toastManager.add({
        title: "Setup complete",
        description: "Your project has been analyzed and tests generated.",
        type: "success",
      });
      setTimeout(() => {
        void navigate({ to: "/onboarding", search: { step: "scenario-dry-run", appId: applicationId }, replace: true });
      }, 1500);
    }
  }, [isCompleted, navigate]);

  return (
    <>
      {/* Step indicators */}
      <div className="mb-8 flex items-center gap-6">
        {SETUP_STEP_NAMES.map((name, index) => (
          <div key={name} className="flex items-center gap-6">
            <StepIndicator step={index} currentStep={currentStep} status={status} />
            {index < SETUP_STEP_NAMES.length - 1 && (
              <div
                className={cn("h-px w-8 transition-colors", index < currentStep ? "bg-primary-ink" : "bg-border-dim")}
              />
            )}
          </div>
        ))}
      </div>

      {/* Waiting for confirmation banner */}
      {waitingForConfirmation && (
        <div className="mb-4 flex items-center gap-3 border border-status-warn/30 bg-status-warn/5 px-5 py-3 animate-pulse">
          <TerminalWindowIcon size={20} weight="fill" className="shrink-0 text-status-warn" />
          <p className="font-mono text-sm text-status-warn">
            Action required in your terminal - confirm in Claude Code to continue to the next step.
          </p>
        </div>
      )}

      {/* Event console */}
      <div className="overflow-hidden border border-border-dim bg-surface-base">
        <div className="flex items-center justify-between border-b border-border-dim bg-surface-raised px-4 py-2">
          <span className="font-mono text-3xs uppercase tracking-widest text-text-tertiary">Agent Log</span>
          <div className="flex items-center gap-1.5">
            {!isCompleted && !isFailed && (
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary-ink opacity-75" />
                <span className="relative inline-flex size-2 rounded-full bg-primary-ink" />
              </span>
            )}
            <span
              className={cn(
                "font-mono text-3xs",
                isFailed ? "text-status-critical" : isCompleted ? "text-status-success" : "text-text-tertiary",
              )}
            >
              {isFailed ? "failed" : isCompleted ? "done" : "live"}
            </span>
          </div>
        </div>

        <div
          ref={consoleRef}
          className="h-72 overflow-y-auto p-4 font-mono text-sm"
          style={{ scrollBehavior: "smooth" }}
        >
          {displayEvents.length === 0 ? (
            <span className="text-text-tertiary opacity-50">waiting for agent output...</span>
          ) : (
            <>
              {displayEvents.map((event) => (
                <div key={event.id} className="mb-1.5 flex items-start gap-3">
                  <span className="mt-0.5 w-20 shrink-0 text-3xs text-text-tertiary opacity-50">
                    {new Date(event.createdAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </span>
                  <span className="mt-0.5 flex size-3 shrink-0 items-center justify-center">
                    {getSetupEventIcon(event.type)}
                  </span>
                  <span
                    className={cn(
                      "break-all text-2xs",
                      event.type === "error" ? "text-status-critical" : "text-text-secondary",
                    )}
                  >
                    {getSetupEventMessage(event)}
                  </span>
                </div>
              ))}
              {!isCompleted && !isFailed && (
                <div className="mt-2 flex items-center gap-3">
                  <span className="w-20 shrink-0 text-3xs text-text-tertiary opacity-50" />
                  <span className="animate-pulse text-text-tertiary">_</span>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Error message */}
      {isFailed && setup?.errorMessage != null && (
        <div className="mt-4 border border-status-critical/30 bg-status-critical/10 p-4 font-mono text-sm text-status-critical">
          {setup.errorMessage}
        </div>
      )}

      {isCompleted && (
        <div className="mt-6 flex items-center gap-3">
          <span className="animate-pulse font-mono text-sm text-primary-ink">Continuing to next step...</span>
        </div>
      )}
    </>
  );
}

function WorkingPageSkeleton() {
  return (
    <div className="space-y-8">
      <div className="flex items-center gap-6">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={`skeleton-${String(i)}`} className="flex items-center gap-6">
            <div className="flex items-center gap-3">
              <Skeleton className="size-7 rounded-full" />
              <Skeleton className="h-4 w-24" />
            </div>
            {i < 3 && <Skeleton className="h-px w-8" />}
          </div>
        ))}
      </div>
      <Skeleton className="h-80 w-full" />
    </div>
  );
}

export function WorkingPage({ appId }: { appId?: string }) {
  const applicationId = appId;

  if (applicationId == null) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="font-mono text-sm text-text-tertiary">No application found. Please start from the beginning.</p>
      </div>
    );
  }

  return (
    <>
      <OnboardingPageHeader
        title="Autonoma's Agent is working on your project"
        description={
          <p>
            The agent is running through all three stages - analyzing your codebase, planning scenarios, and generating
            tests. You can watch its progress in the log below.{" "}
            <span className="font-bold text-primary-ink">Please don&apos;t close this tab.</span>
          </p>
        }
        descriptionClassName="text-sm"
      />

      <div className="mb-8 space-y-3 border border-border-dim bg-surface-base p-5">
        <h3 className="font-mono text-2xs uppercase tracking-widest text-text-tertiary">What each stage does</h3>
        <div className="grid gap-2 text-sm text-text-secondary">
          <p>
            <span className="font-medium text-text-primary">Knowledge Base</span> - Reads your source code, maps pages,
            routes, forms, and interactive elements into a structured understanding of your app.{" "}
            <DocLink href="https://docs.agent.autonoma.app/test-planner/step-1-knowledge-base/">Learn more</DocLink>
          </p>
          <p>
            <span className="font-medium text-text-primary">Scenarios</span> - Creates test data environments (e.g.,
            "user with items in cart") so each test starts from a known state.{" "}
            <DocLink href="https://docs.agent.autonoma.app/test-planner/step-2-scenarios/">Learn more</DocLink>
          </p>
          <p>
            <span className="font-medium text-text-primary">E2E Tests</span> - Generates natural language test files
            covering your app's key user flows, organized by category and priority.{" "}
            <DocLink href="https://docs.agent.autonoma.app/test-planner/step-3-e2e-tests/">Learn more</DocLink>
          </p>
          <p>
            <span className="font-medium text-text-primary">Environment Factory</span> - Sets up the webhook endpoint in
            your project that Autonoma calls to prepare test data before each run.{" "}
            <DocLink href="https://docs.agent.autonoma.app/test-planner/step-4-implement-scenarios/">
              Learn more
            </DocLink>
          </p>
        </div>
      </div>

      <Suspense fallback={<WorkingPageSkeleton />}>
        <SetupProgress applicationId={applicationId} />
      </Suspense>
    </>
  );
}
