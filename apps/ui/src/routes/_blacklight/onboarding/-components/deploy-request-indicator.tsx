import { BrailleSpinner, cn } from "@autonoma/blacklight";

// Phases in which the deploy request was accepted but no environment/build
// activity exists yet - the ~1 minute window before a worker picks the job up.
const PREVIEW_DEPLOY_REQUEST_PHASES = new Set(["deploy_requested"]);

const PREVIEW_DEPLOY_STEPS = [
  { label: "Request accepted", state: "complete" },
  { label: "Waiting for worker", state: "current" },
  { label: "Build queued", state: "pending" },
  { label: "URL pending", state: "pending" },
] as const;

/** True while a deploy was requested but no worker activity has materialized yet. */
export function isPreviewDeployRequestPhase(phase: string | undefined): boolean {
  return phase != null && PREVIEW_DEPLOY_REQUEST_PHASES.has(phase);
}

/**
 * The queued-deploy stepper shown during the request-accepted window, so the user
 * sees the deploy IS moving instead of a silent minute between "deploy sent" and
 * the first build log line. Shared by the manual deploy-verify page and the
 * agent configuring screen.
 */
export function DeployRequestIdleIndicator({ className }: { className?: string }) {
  return (
    <div className={cn("overflow-hidden border border-border-dim bg-surface-raised", className)}>
      <div className="flex items-center gap-3 border-b border-border-dim px-4 py-3">
        <div className="flex size-9 shrink-0 items-center justify-center border border-primary-ink/30 bg-surface-base text-primary-ink">
          <BrailleSpinner animation="orbit" size="md" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-text-primary">Deploy request accepted</p>
          <p className="mt-1 text-xs text-text-secondary">Autonoma is waiting for a deploy worker to start.</p>
        </div>
      </div>

      <div className="grid gap-3 p-4 sm:grid-cols-4">
        {PREVIEW_DEPLOY_STEPS.map((step) => (
          <div key={step.label} className="min-w-0">
            <div
              className={cn(
                "h-1.5 rounded-full",
                step.state === "complete" && "bg-status-success",
                step.state === "current" && "animate-pulse bg-primary-ink",
                step.state === "pending" && "bg-border-mid",
              )}
            />
            <p
              className={cn(
                "mt-2 truncate font-mono text-3xs uppercase tracking-wider",
                step.state === "pending" ? "text-text-secondary" : "text-text-primary",
              )}
            >
              {step.label}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
