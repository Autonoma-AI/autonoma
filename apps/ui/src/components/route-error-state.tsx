import { Button } from "@autonoma/blacklight";
import type { Icon } from "@phosphor-icons/react/lib";
import { WarningOctagonIcon } from "@phosphor-icons/react/WarningOctagon";
import { useQueryErrorResetBoundary } from "@tanstack/react-query";
import type { ReactNode } from "react";

const DEFAULT_MESSAGE = "We couldn't load this.";

interface RouteErrorStateProps {
  /** What failed to load, in the first person plural: "We couldn't load this finding." */
  message?: string;
  icon?: Icon;
  /** TanStack's route-boundary reset. Omitted when this renders inside a plain React boundary. */
  reset?: () => void;
  children?: ReactNode;
}

/**
 * The calm retry every route degrades to instead of a blank page. Wired as the router's
 * `defaultErrorComponent`, so it is what an uncaught loader or render throw resolves to anywhere in the
 * app, and used directly by the routes that want their own wording.
 *
 * Retry has to clear TWO things. TanStack's `reset` only clears the catch boundary's React state; if the
 * throw came from a suspense query, react-query replays the cached rejection and it throws straight back.
 * `useQueryErrorResetBoundary` is what clears that, and both are needed - the pattern
 * `admin/index.tsx` already pairs by hand.
 */
export function RouteErrorState({ message = DEFAULT_MESSAGE, icon, reset, children }: RouteErrorStateProps) {
  const queryErrorReset = useQueryErrorResetBoundary();
  const IconComponent = icon ?? WarningOctagonIcon;

  const retry = () => {
    queryErrorReset.reset();
    reset?.();
  };

  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-border-dim bg-surface-base px-6 py-12 text-center">
      <IconComponent size={28} className="text-text-secondary" />
      <p className="text-sm text-text-secondary">{message}</p>
      {children}
      <Button variant="outline" size="xs" onClick={retry}>
        Try again
      </Button>
    </div>
  );
}
