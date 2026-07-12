import { cn } from "@autonoma/blacklight";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { CubeIcon } from "@phosphor-icons/react/Cube";
import { DatabaseIcon } from "@phosphor-icons/react/Database";
import { TerminalWindowIcon } from "@phosphor-icons/react/TerminalWindow";
import { Link } from "@tanstack/react-router";
import { CONFIG_SUB_STEPS, type ConfigStepId } from "lib/onboarding/config-steps";
import { ONBOARDING_PHASES } from "lib/onboarding/onboarding-phases";
import { buildOnboardingSearch } from "lib/onboarding/onboarding-search";
import type { OnboardingStep } from "lib/onboarding/onboarding-steps";
import type { ComponentType } from "react";

const ALL_STEP_IDS = ONBOARDING_PHASES.flatMap((step) => step.activeSteps);

interface StepProgressProps {
  currentStepId: string;
  /** Active PreviewKit config sub-step, shown as nested sidebar navigation. */
  configStep?: ConfigStepId;
  appId?: string;
}

export function StepProgress({ currentStepId, configStep, appId }: StepProgressProps) {
  const resolvedCurrentStep = resolveStepId(currentStepId);
  const currentIndex = ALL_STEP_IDS.indexOf(resolvedCurrentStep);
  const onConfigStep = resolvedCurrentStep === "previewkit-config";

  return (
    <div className="flex flex-col">
      {ONBOARDING_PHASES.map((step, stepIndex) => {
        const globalIndex = Math.min(...step.activeSteps.map((activeStep) => ALL_STEP_IDS.indexOf(activeStep)));
        const isActive = step.activeSteps.includes(resolvedCurrentStep);
        const isCompleted = globalIndex < currentIndex;
        const isLast = stepIndex === ONBOARDING_PHASES.length - 1;
        const showSubNav = step.id === "preview" && onConfigStep;

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

            <div className={cn("min-w-0 pb-8", isLast && "pb-0")}>
              <StepLabel label={step.label} isActive={isActive} />
              {showSubNav ? <ConfigSubNav activeSubStep={configStep ?? "apps"} appId={appId} /> : undefined}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const SUB_STEP_ICON: Partial<Record<ConfigStepId, ComponentType<{ size?: number; className?: string }>>> = {
  apps: CheckIcon,
  database: DatabaseIcon,
  services: CubeIcon,
  hooks: TerminalWindowIcon,
};

/** The nested Apps / Database / Variables / Optional / Finish navigation under "Config previews". */
function ConfigSubNav({ activeSubStep, appId }: { activeSubStep: ConfigStepId; appId?: string }) {
  const required = CONFIG_SUB_STEPS.filter((step) => step.group === "required");
  const optional = CONFIG_SUB_STEPS.filter((step) => step.group === "optional");
  const finish = CONFIG_SUB_STEPS.find((step) => step.group === "terminal");

  return (
    <div className="mt-3 flex flex-col gap-0.5">
      {required.map((step) => (
        <SubStepLink key={step.id} step={step} active={step.id === activeSubStep} appId={appId} />
      ))}
      <div className="mt-2 flex flex-col gap-0.5 border-t border-dashed border-border-dim pt-2">
        <span className="px-2 pb-0.5 font-mono text-4xs font-bold uppercase tracking-widest text-text-secondary">
          Optional
        </span>
        {optional.map((step) => (
          <SubStepLink key={step.id} step={step} active={step.id === activeSubStep} appId={appId} />
        ))}
      </div>
      {finish != null ? (
        <SubStepLink step={finish} active={finish.id === activeSubStep} appId={appId} className="mt-2" />
      ) : undefined}
    </div>
  );
}

function SubStepLink({
  step,
  active,
  appId,
  className,
}: {
  step: { id: ConfigStepId; label: string };
  active: boolean;
  appId?: string;
  className?: string;
}) {
  const Icon = SUB_STEP_ICON[step.id];
  return (
    <Link
      to="/onboarding"
      search={buildOnboardingSearch("previewkit-config", appId, { configStep: step.id })}
      className={cn(
        "relative flex items-center gap-2 px-2 py-1 font-mono text-2xs transition-colors",
        active ? "text-text-primary" : "text-text-secondary hover:text-text-primary",
        className,
      )}
    >
      {active ? <span className="absolute inset-y-1 left-0 w-0.5 bg-primary-ink" /> : undefined}
      {Icon != null ? (
        <Icon size={12} className={active ? "text-primary-ink" : "text-text-secondary"} />
      ) : (
        <span className="w-3 text-center text-text-secondary">·</span>
      )}
      {step.label}
    </Link>
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
