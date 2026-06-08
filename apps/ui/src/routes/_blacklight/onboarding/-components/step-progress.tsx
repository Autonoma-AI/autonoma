import { cn } from "@autonoma/blacklight";
import { useSuspenseQuery } from "@tanstack/react-query";
import type { OnboardingStep } from "lib/onboarding/onboarding-steps";
import { trpc } from "lib/trpc";
import { Suspense } from "react";

interface StepDef {
  id: OnboardingStep;
  label: string;
}

const STEPS: StepDef[] = [
  { id: "cli-setup", label: "Setup" },
  { id: "scenario-dry-run", label: "Deploy Autonoma SDK" },
  { id: "github", label: "Connect GitHub" },
];

const ALL_STEP_IDS = STEPS.map((step) => step.id);

interface StepProgressProps {
  currentStepId: string;
  appId?: string;
}

export function StepProgress({ currentStepId, appId }: StepProgressProps) {
  const resolvedCurrentStep = ALL_STEP_IDS.includes(currentStepId as OnboardingStep)
    ? (currentStepId as OnboardingStep)
    : "cli-setup";
  const currentIndex = ALL_STEP_IDS.indexOf(resolvedCurrentStep);

  return (
    <div className="flex flex-col">
      {STEPS.map((step, stepIndex) => {
        const globalIndex = ALL_STEP_IDS.indexOf(step.id);
        const isActive = step.id === currentStepId;
        const isCompleted = globalIndex < currentIndex;
        const isLast = stepIndex === STEPS.length - 1;

        // The Setup step is enriched with the application name and the number of
        // tests the CLI uploaded, so the user can recall what they did there
        // without navigating back to it.
        const isSetupStep = step.id === "cli-setup" && appId != null && appId.length > 0;
        const labelContent = isSetupStep ? (
          <Suspense fallback={<StepLabel label="Setup" isActive={isActive} />}>
            <SetupStepLabel appId={appId} isActive={isActive} />
          </Suspense>
        ) : (
          <StepLabel label={step.label} isActive={isActive} />
        );

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

            <div className={cn("pb-8", isLast && "pb-0")}>{labelContent}</div>
          </div>
        );
      })}
    </div>
  );
}

interface StepLabelProps {
  label: string;
  // Rendered after the label in a lighter (secondary) tone - used for the
  // application name on the Setup step, so the name reads as context, not title.
  name?: string;
  subtitle?: string;
  isActive: boolean;
}

function StepLabel({ label, name, subtitle, isActive }: StepLabelProps) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "text-sm font-medium tracking-wide transition-colors",
            isActive ? "text-text-primary" : "text-text-secondary",
          )}
        >
          {label}
          {name != null && <span className="font-normal text-text-secondary"> {name}</span>}
        </span>
        {isActive && (
          <span className="border border-primary-ink/30 bg-primary-ink/10 px-1.5 py-0.5 font-mono text-4xs uppercase tracking-widest text-primary-ink">
            Current
          </span>
        )}
      </div>
      {subtitle != null && <span className="font-mono text-3xs text-text-secondary">{subtitle}</span>}
    </div>
  );
}

function SetupStepLabel({ appId, isActive }: { appId: string; isActive: boolean }) {
  const { data: applications } = useSuspenseQuery(trpc.applications.list.queryOptions());
  const { data: artifactStatus } = useSuspenseQuery(
    trpc.applicationSetups.artifactStatus.queryOptions({ applicationId: appId }),
  );

  const appName = applications.find((app) => app.id === appId)?.name;
  const testCount = extractCount(artifactStatus.artifacts.find((artifact) => artifact.key === "tests")?.meta);

  const label = appName != null ? "Set up" : "Setup";
  const subtitle =
    testCount != null && testCount > 0 ? `${testCount} test${testCount === 1 ? "" : "s"} uploaded` : undefined;

  return <StepLabel label={label} name={appName} subtitle={subtitle} isActive={isActive} />;
}

// The artifact status reports the test count as a human string ("76 files"); pull
// the leading number back out so the sidebar can phrase it as "N tests uploaded".
function extractCount(meta: string | undefined): number | undefined {
  if (meta == null) return undefined;
  const match = meta.match(/\d+/);
  return match != null ? Number(match[0]) : undefined;
}
