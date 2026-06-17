import { Skeleton, buttonVariants } from "@autonoma/blacklight";
import { CheckSquareIcon } from "@phosphor-icons/react/CheckSquare";
import { SparkleIcon } from "@phosphor-icons/react/Sparkle";
import { Link, Navigate, createFileRoute, useNavigate } from "@tanstack/react-router";
import { buildOnboardingSearch } from "lib/onboarding/onboarding-search";
import { useApplications } from "lib/query/applications.queries";
import { Suspense, useEffect } from "react";
import { setLastApp } from "../_app-shell/-last-app";

export const Route = createFileRoute("/_blacklight/onboarding/complete")({
  component: () => <Navigate to="/onboarding" search={buildOnboardingSearch("complete")} />,
});

export function CompletePage({ appId }: { appId?: string }) {
  return (
    <Suspense fallback={<CompletePageSkeleton />}>
      <CompletePageContent appId={appId} />
    </Suspense>
  );
}

function CompletePageSkeleton() {
  return (
    <div className="flex flex-col items-center py-10 text-center sm:py-12">
      <Skeleton className="mb-10 size-28 rounded-full" />
      <Skeleton className="h-14 w-80" />
      <Skeleton className="mt-5 h-12 w-96 max-w-full" />
      <Skeleton className="mt-14 h-12 w-56" />
    </div>
  );
}

function CompletePageContent({ appId }: { appId?: string }) {
  const navigate = useNavigate();
  const { data: applications } = useApplications();
  const application = applications.find((app) => app.id === appId);

  useEffect(() => {
    if (application != null) {
      setLastApp(application.slug);
    }

    const timer = setTimeout(() => {
      if (application != null) {
        void navigate({ to: "/app/$appSlug", params: { appSlug: application.slug }, replace: true });
        return;
      }
      void navigate({ to: "/", replace: true });
    }, 2000);
    return () => clearTimeout(timer);
  }, [application, navigate]);

  return (
    <>
      <style>{`
        @keyframes connectedFloat {
          0%, 100% { transform: translateY(0) rotate(-6deg); }
          30% { transform: translateY(-14px) rotate(7deg); }
          60% { transform: translateY(-8px) rotate(-3deg); }
          80% { transform: translateY(-16px) rotate(9deg); }
        }
        @keyframes connectedGlow {
          0%, 100% { box-shadow: 0 0 16px var(--accent-glow), 0 0 32px var(--accent-glow); }
          50% { box-shadow: 0 0 32px var(--accent-glow), 0 0 64px var(--accent-glow); }
        }
      `}</style>

      <div className="flex flex-col items-center py-10 text-center sm:py-12">
        <div
          className="mb-10 flex size-28 items-center justify-center rounded-full border border-primary-ink/20 bg-surface-base"
          style={{ animation: "connectedGlow 3s ease-in-out infinite" }}
        >
          <CheckSquareIcon
            size={52}
            weight="duotone"
            className="text-primary-ink"
            style={{ animation: "connectedFloat 4s ease-in-out infinite" }}
          />
        </div>

        <h1 className="mt-4 text-5xl font-medium tracking-tight text-text-primary">You're connected</h1>

        <p className="mt-5 max-w-md text-base leading-relaxed text-text-secondary">
          The preview is live and Autonoma can now generate and run browser tests against it.
        </p>

        {application != null ? (
          <Link
            to="/app/$appSlug"
            params={{ appSlug: application.slug }}
            className={buttonVariants({
              variant: "accent",
              className: "mt-14 gap-3 px-10 py-4 font-mono text-sm font-bold uppercase",
            })}
            aria-label="onboarding-complete-start-now"
          >
            <SparkleIcon size={18} weight="bold" />
            Start now
          </Link>
        ) : (
          <Link
            to="/"
            className={buttonVariants({
              variant: "accent",
              className: "mt-14 gap-3 px-10 py-4 font-mono text-sm font-bold uppercase",
            })}
            aria-label="onboarding-complete-start-now"
          >
            <SparkleIcon size={18} weight="bold" />
            Start now
          </Link>
        )}

        <p className="mt-4 font-mono text-2xs text-text-secondary opacity-60">Generation can start from this preview</p>
      </div>
    </>
  );
}
