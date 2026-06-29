import { buttonVariants, cn } from "@autonoma/blacklight";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { SlidersHorizontalIcon } from "@phosphor-icons/react/SlidersHorizontal";
import { Link } from "@tanstack/react-router";

interface FinishSetupPromptProps {
  appName: string;
  appSlug: string;
  sdkConfigured: boolean;
  artifactsUploaded: boolean;
  dryRunPassed: boolean;
}

/**
 * Home takeover shown until the three compulsory deepening steps are complete.
 * Autonoma can't run test generations without them, so Home leads with this
 * centered prompt instead of the empty PR list / bugs rail.
 */
export function FinishSetupPrompt({
  appName,
  appSlug,
  sdkConfigured,
  artifactsUploaded,
  dryRunPassed,
}: FinishSetupPromptProps) {
  const steps = [
    { label: "Implement the Autonoma SDK", done: sdkConfigured },
    { label: "Upload test artifacts", done: artifactsUploaded },
    { label: "Dry-run your scenarios", done: dryRunPassed },
  ];
  const completedCount = steps.filter((step) => step.done).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6">
        <div className="flex w-full max-w-md flex-col items-center gap-6 text-center">
          <div className="flex size-12 items-center justify-center rounded-full border border-border-mid bg-surface-raised text-text-primary">
            <SlidersHorizontalIcon size={22} />
          </div>

          <div className="flex flex-col gap-2">
            <h2 className="text-xl font-medium tracking-tight text-text-primary">Finish setting up {appName}</h2>
            <p className="text-sm leading-relaxed text-text-secondary">
              Autonoma can't generate or run tests yet. Complete these three steps so it can provision real test data
              and validate your app end-to-end.
            </p>
          </div>

          <ol className="flex w-full flex-col gap-2 text-left">
            {steps.map((step, index) => (
              <li
                key={step.label}
                className="flex items-center gap-3 border border-border-dim bg-surface-base px-3 py-2.5"
              >
                {step.done ? (
                  <CheckCircleIcon size={18} weight="fill" className="shrink-0 text-status-success" />
                ) : (
                  <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full border border-border-mid font-mono text-3xs text-text-secondary">
                    {index + 1}
                  </span>
                )}
                <span className={cn("text-sm", step.done ? "text-text-secondary line-through" : "text-text-primary")}>
                  {step.label}
                </span>
              </li>
            ))}
          </ol>

          <div className="flex flex-col items-center gap-3">
            <Link
              to="/app/$appSlug/finish-setup"
              params={{ appSlug }}
              className={buttonVariants({
                variant: "accent",
                className: "gap-2 px-6 py-3 font-mono text-sm font-bold uppercase",
              })}
            >
              Finish setup
              <ArrowRightIcon size={16} weight="bold" />
            </Link>
            <p className="font-mono text-2xs text-text-secondary">{completedCount} of 3 steps done</p>
          </div>
        </div>
      </div>
    </div>
  );
}
