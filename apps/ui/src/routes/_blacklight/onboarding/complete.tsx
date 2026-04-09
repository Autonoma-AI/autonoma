import { Button } from "@autonoma/blacklight";
import { BugIcon } from "@phosphor-icons/react/Bug";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { trpcClient } from "lib/trpc";
import { useEffect, useRef, useState } from "react";
import { onboardingSearchSchema } from "./-onboarding-search";

export const Route = createFileRoute("/_blacklight/onboarding/complete")({
  component: CompletePage,
  validateSearch: onboardingSearchSchema,
});

async function resolveAppSlug(applicationId: string): Promise<string | undefined> {
  const apps = await trpcClient.applications.list.query();
  return apps.find((a) => a.id === applicationId)?.slug;
}

function CompletePage() {
  const { appId } = Route.useSearch();
  const navigate = useNavigate();
  const resolved = useRef(false);
  const [appSlug, setAppSlug] = useState<string>();

  useEffect(() => {
    if (!resolved.current) {
      resolved.current = true;
      void resolveAppSlug(appId).then(setAppSlug);
    }
  }, [appId]);

  function navigateToApp() {
    if (appSlug != null) {
      void navigate({ to: "/app/$appSlug", params: { appSlug } });
    } else {
      void navigate({ to: "/" });
    }
  }

  useEffect(() => {
    // Auto-navigate once we have resolved the app slug (or after a timeout fallback)
    if (appSlug != null) {
      const timer = setTimeout(navigateToApp, 2000);
      return () => clearTimeout(timer);
    }

    // Fallback: if slug resolution takes too long, navigate home
    const fallback = setTimeout(() => {
      void navigate({ to: "/" });
    }, 4000);
    return () => clearTimeout(fallback);
  }, [appSlug, navigate]);

  return (
    <>
      <style>{`
        @keyframes bugFloat {
          0%, 100% { transform: translateY(0) rotate(-6deg); }
          30% { transform: translateY(-14px) rotate(7deg); }
          60% { transform: translateY(-8px) rotate(-3deg); }
          80% { transform: translateY(-16px) rotate(9deg); }
        }
        @keyframes bugGlow {
          0%, 100% { box-shadow: 0 0 16px var(--accent-glow), 0 0 32px var(--accent-glow); }
          50% { box-shadow: 0 0 32px var(--accent-glow), 0 0 64px var(--accent-glow); }
        }
      `}</style>

      <div className="flex flex-col items-center py-16 text-center">
        <div
          className="mb-10 flex size-28 items-center justify-center rounded-full border border-primary-ink/20 bg-surface-base"
          style={{ animation: "bugGlow 3s ease-in-out infinite" }}
        >
          <BugIcon
            size={52}
            weight="duotone"
            className="text-primary-ink"
            style={{ animation: "bugFloat 4s ease-in-out infinite" }}
          />
        </div>

        <h1 className="mt-4 text-5xl font-medium tracking-tight text-text-primary">Ready to hunt some bugs</h1>

        <p className="mt-5 max-w-md text-base leading-relaxed text-text-secondary">
          Your scenarios are live. Autonoma will run them automatically and alert you when something breaks.
        </p>

        <Button
          variant="accent"
          className="mt-14 gap-3 px-10 py-4 font-mono text-sm font-bold uppercase"
          onClick={navigateToApp}
          aria-label="onboarding-complete-start-now"
        >
          <BugIcon size={18} weight="bold" />
          Start now
        </Button>

        <p className="mt-4 font-mono text-2xs text-text-tertiary opacity-60">Let the bug hunting season begin</p>
      </div>
    </>
  );
}
