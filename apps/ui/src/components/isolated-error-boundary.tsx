import * as Sentry from "@sentry/react";
import { isTRPCClientError } from "@trpc/client";
import { Component, type ErrorInfo, type ReactNode } from "react";

interface IsolatedErrorBoundaryProps {
  children: ReactNode;
  /**
   * What to show in its place, given a way back. Defaults to nothing, which is right for a passive glance at
   * a number - an error where a number belongs asks the reader to deal with a problem that is not theirs.
   * Give it a fallback when the failed piece was carrying a way to get somewhere, so the route survives it.
   *
   * `retry` clears this boundary so the children mount again. Anything offering a retry must call it: a
   * fallback that only resets the query cache leaves the boundary latched, and the button does nothing.
   */
  fallback?: (retry: () => void) => ReactNode;
}

/**
 * Contains a failed fetch to the piece of the page that made it.
 *
 * The router now gives every route an error boundary, which is the right home for a failure in what the route
 * is *for*. This is for everything else: a status chip in a heading, a meter in the bar, an aside beside the
 * table. Those read from their own suspense queries, so without a boundary of their own a throw propagates to
 * the route and replaces an entire working page with a retry screen because a secondary detail could not load.
 * A background poll makes it worse - it re-throws on the next render, so the page cannot recover on its own.
 */
export class IsolatedErrorBoundary extends Component<IsolatedErrorBoundaryProps, { hasError: boolean }> {
  override state: { hasError: boolean } = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  /**
   * The same division of labour the router's `defaultOnCatch` uses. `lib/trpc.ts`'s `queryCache.onError`
   * has already captured every failed query, which is most of what these boundaries catch, so reporting
   * those again would double-count the common case. What would otherwise vanish without a trace is a
   * render-time throw inside the isolated piece: this boundary is the only thing between it and the route,
   * so nothing downstream ever sees it.
   */
  override componentDidCatch(error: Error, info: ErrorInfo) {
    if (isTRPCClientError(error)) return;
    Sentry.captureException(error, { contexts: { react: { componentStack: info.componentStack } } });
  }

  private readonly retry = () => {
    this.setState({ hasError: false });
  };

  override render() {
    if (!this.state.hasError) return this.props.children;
    return this.props.fallback?.(this.retry) ?? null;
  }
}
