import { BrailleSpinner, Button, Skeleton } from "@autonoma/blacklight";
import { isPreviewUrl } from "@autonoma/types";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { CloudSlashIcon } from "@phosphor-icons/react/CloudSlash";
import type { Icon } from "@phosphor-icons/react/lib";
import { MoonIcon } from "@phosphor-icons/react/Moon";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { env } from "env";
import { currentPathForRedirect } from "lib/auth-redirect";
import { ensureSessionData } from "lib/query/auth.queries";
import { usePreviewStatus } from "lib/query/preview-access.queries";
import { Suspense, useEffect, useState } from "react";

/**
 * What we tell people a wake takes.
 *
 * Deliberately pessimistic. Measured on the preview cluster: p50 50s, p75 119s,
 * p90 199s - so "under a minute" would be wrong for nearly half of all wakes, and
 * a promise the page visibly breaks is worse than no promise at all. Two minutes
 * covers ~75%, so most people beat the estimate instead of watching it expire.
 */
const WAKE_ETA = "Usually ready within two minutes";

/** A build is minutes of work, not a pod start, so it gets its own vaguer estimate. */
const DEPLOY_ETA = "Builds usually take a few minutes";

/**
 * Waiting room for a preview that is starting up.
 *
 * Previews scale to zero, and the proxy in front of them holds a request to a
 * sleeping environment - sending no bytes - until every workload is ready. Measured
 * wakes are ~50s at p50 and nearly half exceed 60s, which in a browser is a blank
 * tab that reads as broken; most people leave. The front door
 * (`GET /v1/previewkit/open`) sends browsers here instead, so the wait has a face
 * and ends by itself.
 */
export const Route = createFileRoute("/preview-waiting")({
  validateSearch: (search: Record<string, unknown>): { to: string } => ({
    to: typeof search.to === "string" ? search.to : "",
  }),
  beforeLoad: async ({ context: { queryClient } }) => {
    const session = await ensureSessionData(queryClient);
    if (session == null) {
      throw redirect({ to: "/login", search: { redirectTo: currentPathForRedirect(window.location) } });
    }
  },
  component: PreviewWaitingPage,
  // Without this, a first-load failure - the session fetch above, or the status
  // query after React Query exhausts its retries - falls through to TanStack's
  // generic default, which offers no way out. Someone arrives here from a GitHub
  // comment already waiting on a slow preview, so a dead end is the worst possible
  // ending. Later poll failures never reach this: React Query keeps the last good
  // data, so the page stays on whatever state it was showing.
  errorComponent: PreviewWaitingError,
});

function PreviewWaitingError() {
  return (
    <Outcome
      icon={WarningIcon}
      title="We couldn't check on this preview"
      body="Something went wrong reaching Autonoma. The preview itself may be perfectly fine - try again, or open it directly."
      onRetry={() => window.location.reload()}
    />
  );
}

function PreviewWaitingPage() {
  const { to } = Route.useSearch();

  // Guard before anything is rendered or polled: `to` is attacker-controlled and
  // this page hands it to the browser, so an unvalidated value is an open
  // redirect onto a fresh session.
  if (!isPreviewUrl(to, env.VITE_INTERNAL_DOMAIN)) {
    return (
      <Outcome
        icon={WarningIcon}
        title="That link doesn't point at a preview"
        body="The address is missing or isn't an Autonoma preview environment. Open the preview from the pull request or from your app in Autonoma."
      />
    );
  }

  return (
    <Suspense fallback={<PreviewWaitingSkeleton />}>
      <PreviewWaitingBody to={to} />
    </Suspense>
  );
}

function PreviewWaitingBody({ to }: { to: string }) {
  const { data } = usePreviewStatus(to);

  // Cross-origin hand-off, so TanStack Router cannot do it. `replace` keeps the
  // waiting room out of history: a back press should return where they came
  // from, not bounce them through here again.
  useEffect(() => {
    if (data.state === "ready") window.location.replace(to);
  }, [data.state, to]);

  switch (data.state) {
    case "ready":
      return <Outcome icon={MoonIcon} title="Opening the preview" body="Taking you there now." waiting />;
    case "waking":
      return (
        <Outcome
          icon={MoonIcon}
          title="Waking up the preview"
          body="Previews sleep when nobody is using them and start again on the first visit. We'll take you there the moment it's ready - you don't need to refresh."
          eta={WAKE_ETA}
          waiting
          to={to}
        />
      );
    case "deploying":
      return (
        <Outcome
          icon={MoonIcon}
          title="This preview is still deploying"
          body="The build hasn't finished yet. This page will move on as soon as the environment is up."
          eta={DEPLOY_ETA}
          waiting
          to={to}
        />
      );
    case "failed":
      return (
        <Outcome
          icon={WarningIcon}
          title="This preview didn't deploy"
          body="The last deploy for this pull request failed, so there's nothing to open. The build and runtime logs in Autonoma will say why."
        />
      );
    case "gone":
      return (
        <Outcome
          icon={CloudSlashIcon}
          title="This preview has been torn down"
          body="Previews are removed once their pull request closes, or when a newer commit replaces them. Reopening or pushing to the pull request creates a fresh one."
        />
      );
    case "not_found":
      return (
        <Outcome
          icon={CloudSlashIcon}
          title="Preview not available"
          body="This preview doesn't exist, or it belongs to an organization your account isn't a member of."
        />
      );
  }
}

interface OutcomeProps {
  icon: Icon;
  title: string;
  body: string;
  /** Marks a state we are still waiting on: spins the indicator and counts the wait. */
  waiting?: boolean;
  /** How long this normally takes. Deliberately generous - see WAKE_ETA. */
  eta?: string;
  /** When still waiting, offer the raw URL as an escape hatch. */
  to?: string;
  /** Recovery affordance for the error state, where there is no preview URL to fall back to. */
  onRetry?: () => void;
}

// `blacklight` carries the theme tokens. Routes under `_blacklight` inherit it
// from that layout, but this one is root-level (it must render before any app
// shell), so it has to opt in or `bg-surface-void` resolves to nothing and the
// page renders as black-on-white.
function Outcome({ icon: OutcomeIcon, title, body, waiting, eta, to, onRetry }: OutcomeProps) {
  return (
    <div className="blacklight flex min-h-dvh items-center justify-center bg-surface-void px-6">
      <div className="flex max-w-md flex-col items-center text-center">
        <div className="flex size-12 items-center justify-center rounded-2xl bg-surface-raised">
          {waiting === true ? (
            <BrailleSpinner animation="braille" size="xl" className="text-text-primary" />
          ) : (
            <OutcomeIcon className="size-6 text-text-secondary" />
          )}
        </div>
        <h1 className="mt-6 text-xl font-medium tracking-tight text-text-primary">{title}</h1>
        <p className="mt-3 text-sm text-text-secondary">{body}</p>
        {eta != null && <WaitProgress eta={eta} />}
        {onRetry != null && (
          <Button variant="outline" size="sm" className="mt-6" onClick={onRetry}>
            Try again
          </Button>
        )}
        {to != null && (
          <Button
            variant="outline"
            size="sm"
            className="mt-6"
            render={<a href={to} target="_blank" rel="noreferrer" />}
          >
            Open it anyway
            <ArrowSquareOutIcon className="size-4" />
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * The ETA plus a ticking count of how long they have actually been here.
 *
 * The elapsed number is the part that matters: during a cold start nothing else
 * on screen changes, so without it a visitor cannot tell a page that is working
 * from one that has hung - which is the whole failure this feature exists to fix.
 */
function WaitProgress({ eta }: { eta: string }) {
  const elapsed = useElapsedSeconds();

  return (
    <p className="mt-4 font-mono text-2xs text-text-secondary">
      {eta} · waiting {formatElapsed(elapsed)}
    </p>
  );
}

function useElapsedSeconds(): number {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setSeconds((previous) => previous + 1), 1_000);
    return () => clearInterval(id);
  }, []);

  return seconds;
}

function formatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function PreviewWaitingSkeleton() {
  return (
    <div className="blacklight flex min-h-dvh items-center justify-center bg-surface-void px-6">
      <div className="flex max-w-md flex-col items-center">
        <Skeleton className="size-12 rounded-2xl" />
        <Skeleton className="mt-6 h-6 w-56" />
        <Skeleton className="mt-3 h-4 w-80" />
      </div>
    </div>
  );
}
