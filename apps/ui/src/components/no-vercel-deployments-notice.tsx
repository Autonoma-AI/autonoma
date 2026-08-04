import { BrailleSpinner, Button, buttonVariants, cn } from "@autonoma/blacklight";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react/ArrowsClockwise";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";

/**
 * No per-project deep link is possible: the linked project is only `{ id, name }`
 * and no Vercel team slug is stored, so a `vercel.com/<team>/<project>` URL can't
 * be built. The project name in the copy tells the user which one to open.
 */
const VERCEL_DASHBOARD_URL = "https://vercel.com/dashboard";

interface NoVercelDeploymentsNoticeProps {
  /** Linked Vercel project, when known - names what to look for on Vercel. */
  projectName?: string;
  /** Set when the deployments query failed; switches the copy to the load-failure variant. */
  errorMessage?: string;
  /** A fetch (manual retry or the empty-list poll) is in flight. */
  isChecking: boolean;
  onCheckAgain: () => void;
  /** Call-site sentence about what the deployment would have been used for. */
  hint?: string;
  className?: string;
}

/**
 * The deployment picker's blocking empty state. Red because it is a dead end:
 * with no deployment there is no preview URL, so the flow cannot continue - the
 * user has to go deploy something or retry, and both actions live here.
 */
export function NoVercelDeploymentsNotice({
  projectName,
  errorMessage,
  isChecking,
  onCheckAgain,
  hint,
  className,
}: NoVercelDeploymentsNoticeProps) {
  const project = projectName != null ? <span className="font-mono">{projectName}</span> : "This project";

  return (
    <div
      className={cn("flex flex-col gap-3 border border-status-critical/30 bg-status-critical/5 px-4 py-3.5", className)}
    >
      <div className="flex items-start gap-2">
        <WarningCircleIcon size={16} weight="fill" className="mt-0.5 shrink-0 text-status-critical" />
        <div className="min-w-0 flex-1">
          <p className="font-mono text-2xs uppercase tracking-widest text-status-critical">
            {errorMessage != null ? "Couldn't load deployments" : "No ready deployments"}
          </p>
          {errorMessage != null ? (
            <p className="mt-2 text-sm text-text-primary">{errorMessage}</p>
          ) : (
            <>
              <p className="mt-2 text-sm text-text-primary">
                {project} has no finished deployment to use, so this step can&apos;t continue.
              </p>
              <p className="mt-1 text-sm text-text-secondary">
                Only builds that finished successfully show up here - one still running, or one that failed, will not.
                Deploy on Vercel and this list picks it up on its own.
              </p>
            </>
          )}
          {hint != null ? <p className="mt-1 text-sm text-text-secondary">{hint}</p> : undefined}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 pl-6">
        <Button variant="outline" size="xs" className="gap-1.5" onClick={onCheckAgain} disabled={isChecking}>
          {isChecking ? <BrailleSpinner animation="braille" size="sm" /> : <ArrowsClockwiseIcon size={12} />}
          {isChecking ? "Checking..." : "Check again"}
        </Button>
        <a
          href={VERCEL_DASHBOARD_URL}
          target="_blank"
          rel="noopener noreferrer"
          className={buttonVariants({ variant: "ghost", size: "xs", className: "gap-1.5" })}
        >
          Open Vercel
          <ArrowSquareOutIcon size={12} />
        </a>
      </div>
    </div>
  );
}
