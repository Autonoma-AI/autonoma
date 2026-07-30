import { Badge, cn, Tooltip, TooltipContent, TooltipTrigger } from "@autonoma/blacklight";
import { InfoIcon } from "@phosphor-icons/react/Info";
import type { ComponentProps } from "react";

type BadgeVariant = ComponentProps<typeof Badge>["variant"];

// The single source of help copy for every preview status label - runtime
// (Live/Idle/Waking/Crashing) and deploy (Building/Failed/...) alike - so the two
// badge families share one registry instead of each keeping their own. Keyed by
// the human label; call sites pass `PREVIEW_STATUS_HELP[meta.label]`. Labels with
// no entry (e.g. "Ready"/"Success") render a plain badge with no (i).
export const PREVIEW_STATUS_HELP: Record<string, string> = {
  // Runtime (from the cluster's live workload state, via PreviewLivenessBadge).
  Live: "Up and serving requests.",
  Waking: "Starting back up after being idle - usually ready within a minute.",
  Idle: "Deployed but scaled to zero to save resources. Opening it wakes it back up (~1 min).",
  Crashing: "Deployed, but the app isn't staying up (a crash loop or a bad image). Check the app logs.",
  // Deploy status (build/deploy outcome, pre-empts liveness).
  Building: "Still building and deploying - it isn't reachable yet.",
  Failed: "The build or deploy failed, so nothing came up. Check the logs.",
  Degraded: "Deployed, but one or more services are unhealthy.",
  Superseded: "Replaced by a newer deploy.",
  Fallback: "Running on a fallback build.",
  Stopped: "Scaled down and not running.",
  Missing: "No preview environment for this branch yet.",
  Stale: "Behind the branch's latest commit.",
};

/**
 * The one preview status badge: an uppercase label with an (i) tooltip and no
 * leading dot, so every status across the preview surfaces - runtime
 * (Live/Idle/Waking/Crashing) and deploy (Building/Failed/...) - reads
 * identically. Pass `help` to show the tooltip; omit it for a plain badge.
 */
export function PreviewStatusBadge({
  label,
  variant,
  help,
  className,
}: {
  label: string;
  variant?: BadgeVariant;
  help?: string;
  className?: string;
}) {
  return (
    <Badge variant={variant} className={cn("shrink-0 gap-1 font-mono text-[10px] uppercase", className)}>
      {label}
      {help != null && (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={`What "${label}" means`}
                className="flex items-center opacity-60 transition-opacity hover:opacity-100"
              >
                <InfoIcon size={11} />
              </button>
            }
          />
          <TooltipContent className="max-w-xs normal-case">{help}</TooltipContent>
        </Tooltip>
      )}
    </Badge>
  );
}
