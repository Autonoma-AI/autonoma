import { cn } from "@autonoma/blacklight";
import type { OnboardingStep } from "lib/onboarding/onboarding-steps";

interface StepDef {
  id: string;
  label: string;
  activeSteps: OnboardingStep[];
}

const STEPS: StepDef[] = [
  { id: "create-app", label: "Create app", activeSteps: ["add-app"] },
  {
    id: "preview",
    label: "Config previews",
    activeSteps: ["preview-environment", "previewkit-config", "existing-deploys", "deploy-verify"],
  },
  { id: "finish", label: "Finish", activeSteps: ["diff-trigger", "complete"] },
];

const ALL_STEP_IDS = STEPS.flatMap((step) => step.activeSteps);

interface StepProgressProps {
  currentStepId: string;
}

export function StepProgress({ currentStepId }: StepProgressProps) {
  const resolvedCurrentStep = resolveStepId(currentStepId);
  const currentIndex = ALL_STEP_IDS.indexOf(resolvedCurrentStep);

  return (
    <div className="flex flex-col">
      {STEPS.map((step, stepIndex) => {
        const globalIndex = Math.min(...step.activeSteps.map((activeStep) => ALL_STEP_IDS.indexOf(activeStep)));
        const isActive = step.activeSteps.includes(resolvedCurrentStep);
        const isCompleted = globalIndex < currentIndex;
        const isLast = stepIndex === STEPS.length - 1;

        return (
          <div key={step.id} className="flex gap-5">
            <div className="flex flex-col items-center">
              <div
                className={cn(
                  "mt-1.5 size-2 shrink-0 rounded-full transition-colors",
                  isActive && "bg-primary-ink shadow-[0_0_8px_var(--accent-glow)]",
                  isCompleted && "bg-primary-ink",
                  !isActive && !isCompleted && "border border-border-dim bg-surface-void",
                )}
              />
              {!isLast && (
                <div
                  className={cn(
                    "my-1 w-px flex-1 transition-colors",
                    isActive && "bg-primary-ink shadow-[0_0_10px_var(--accent-glow)]",
                    isCompleted && "bg-primary-ink/40",
                    !isActive && !isCompleted && "bg-border-dim",
                  )}
                />
              )}
            </div>

            <div className={cn("pb-8", isLast && "pb-0")}>
              <StepLabel label={step.label} isActive={isActive} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

interface StepLabelProps {
  label: string;
  isActive: boolean;
}

function StepLabel({ label, isActive }: StepLabelProps) {
  return (
    <div className="flex items-center gap-2">
      <span
        className={cn(
          "text-sm font-medium tracking-wide transition-colors",
          isActive ? "text-text-primary" : "text-text-secondary",
        )}
      >
        {label}
      </span>
      {isActive && (
        <span className="border border-primary-ink/30 bg-primary-ink/10 px-1.5 py-0.5 font-mono text-4xs uppercase tracking-widest text-primary-ink">
          Current
        </span>
      )}
    </div>
  );
}

function resolveStepId(stepId: string): OnboardingStep {
  const matchingStep = ALL_STEP_IDS.find((knownStep) => knownStep === stepId);
  return matchingStep ?? "add-app";
}
