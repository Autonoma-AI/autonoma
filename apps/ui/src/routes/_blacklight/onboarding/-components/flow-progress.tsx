import { cn } from "@autonoma/blacklight";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { ONBOARDING_PHASES } from "lib/onboarding/onboarding-flow";

const ALL_STEP_IDS: readonly string[] = ONBOARDING_PHASES.flatMap((phase) => phase.activeSteps);

/**
 * Where the user is in onboarding, as a horizontal rail across the top chrome.
 *
 * Onboarding is one flow with no way out until it is done, so the rail is
 * orientation only - it reports position and never offers navigation. Jumping to
 * an arbitrary phase would skip work the later phases depend on, and the flow's
 * own Back/Next is the one way to move.
 */
export function FlowProgress({ currentStepId }: { currentStepId: string }) {
  // `complete` belongs to no phase, so it resolves to -1: everything is behind the
  // user, which is exactly what the finished rail should show.
  const currentIndex = ALL_STEP_IDS.findIndex((step) => step === currentStepId);
  const isFinished = currentIndex < 0;

  return (
    <ol className="flex items-center gap-1.5">
      {ONBOARDING_PHASES.map((phase, index) => {
        const phaseIndex = Math.min(...phase.activeSteps.map((step) => ALL_STEP_IDS.indexOf(step)));
        const isActive = !isFinished && phase.activeSteps.some((step) => step === currentStepId);
        const isCompleted = isFinished || phaseIndex < currentIndex;

        return (
          <li key={phase.id} className="flex items-center gap-1.5">
            {index > 0 && <span className={cn("h-px w-4", isCompleted ? "bg-primary-ink/40" : "bg-border-dim")} />}
            <span
              className={cn(
                "flex items-center gap-1.5 px-2 py-1 font-mono text-3xs uppercase tracking-widest transition-colors",
                isActive && "border border-primary-ink/30 bg-primary-ink/10 text-primary-ink",
                isCompleted && !isActive && "text-text-secondary",
                !isActive && !isCompleted && "text-text-secondary opacity-50",
              )}
            >
              {isCompleted && !isActive ? (
                <CheckIcon size={10} weight="bold" className="text-primary-ink" />
              ) : (
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    isActive ? "bg-primary-ink shadow-[0_0_8px_var(--accent-glow)]" : "bg-border-mid",
                  )}
                />
              )}
              {phase.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
