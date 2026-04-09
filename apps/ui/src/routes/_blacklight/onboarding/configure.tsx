import { Skeleton } from "@autonoma/blacklight";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Claude } from "components/icons";
import { sounds } from "lib/onboarding/sounds";
import { usePollApplicationSetup } from "lib/query/app-generations.queries";
import { toastManager } from "lib/toast-manager";
import { Suspense, useEffect, useRef } from "react";
import { CodeBlock } from "./-components/code-block";
import { onboardingSearchSchema } from "./-onboarding-search";

export const Route = createFileRoute("/_blacklight/onboarding/configure")({
  component: ConfigurePage,
  validateSearch: onboardingSearchSchema,
});

function WaitingForAgent({ applicationId }: { applicationId: string }) {
  const navigate = useNavigate();
  const { appId } = Route.useSearch();
  const { data: setup } = usePollApplicationSetup(applicationId);
  const navigatedRef = useRef(false);

  useEffect(() => {
    if (setup != null && !navigatedRef.current) {
      navigatedRef.current = true;
      sounds.agentConnected();
      toastManager.add({ title: "Agent connected", type: "success", timeout: 3000 });
      setTimeout(() => {
        void navigate({ to: "/onboarding/working", search: { appId } });
      }, 350);
    }
  }, [setup, navigate, appId]);

  return (
    <div className="space-y-10">
      {/* Step 1: Reload plugins */}
      <div className="relative pl-10">
        <div className="absolute left-0 top-0 flex size-7 items-center justify-center bg-surface-void">
          <div className="size-3 rounded-full border-2 border-primary-ink shadow-[0_0_10px_var(--accent-glow)]" />
        </div>

        <div className="mb-4">
          <div className="flex items-baseline gap-3">
            <span className="font-mono text-sm font-medium text-primary-ink">Step 1</span>
            <h3 className="text-xl font-medium text-text-primary">Reload plugins</h3>
          </div>
          <p className="mt-1 text-sm text-text-secondary">Reload plugins to make sure the latest version is loaded.</p>
        </div>

        <div className="max-w-2xl">
          <CodeBlock>/reload-plugins</CodeBlock>
        </div>
      </div>

      {/* Step 2: Run the plugin */}
      <div className="relative pl-10">
        <div className="absolute left-0 top-0 flex size-7 items-center justify-center bg-surface-void">
          <div className="size-3 rounded-full border-2 border-primary-ink shadow-[0_0_10px_var(--accent-glow)]" />
        </div>

        <div className="mb-4">
          <div className="flex items-baseline gap-3">
            <span className="font-mono text-sm font-medium text-primary-ink">Step 2</span>
            <h3 className="text-xl font-medium text-text-primary">Run the plugin</h3>
          </div>
          <p className="mt-1 text-sm text-text-secondary">Run the test planner inside Claude Code.</p>
        </div>

        <div className="max-w-2xl">
          <CodeBlock>/autonoma-test-planner:generate-tests</CodeBlock>
        </div>

        <p className="mt-3 flex items-center gap-2.5 font-mono text-2xs text-text-secondary">
          <Claude /> Works best with Opus 4.6
        </p>
      </div>

      {/* Waiting indicator */}
      <div className="pl-10">
        <div className="flex items-center gap-3">
          <span className="relative flex size-2.5">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary-ink opacity-75" />
            <span className="relative inline-flex size-2.5 rounded-full bg-primary-ink" />
          </span>
          <span className="font-mono text-sm text-text-secondary">
            Waiting for events from agent...{" "}
            <span className="font-bold text-primary-ink">Please don&apos;t close this tab.</span>
          </span>
        </div>
      </div>
    </div>
  );
}

function ConfigurePageSkeleton() {
  return (
    <div className="space-y-10">
      <div className="relative pl-10">
        <Skeleton className="mb-4 h-8 w-64" />
        <Skeleton className="h-5 w-96" />
        <Skeleton className="mt-4 h-12 w-full max-w-2xl" />
        <Skeleton className="mt-3 h-4 w-48" />
      </div>
      <div className="pl-10">
        <Skeleton className="h-5 w-64" />
      </div>
    </div>
  );
}

function ConfigurePage() {
  const { appId } = Route.useSearch();

  return (
    <>
      <header className="mb-14 border-b border-border-dim pb-8">
        <h1 className="text-4xl font-medium tracking-tight text-text-primary">Configure your project</h1>
        <p className="mt-3 font-mono text-sm text-text-secondary">
          Run the test planner plugin to generate tests for your project.
        </p>
      </header>

      <div className="ml-4 max-w-2xl">
        <Suspense fallback={<ConfigurePageSkeleton />}>
          <WaitingForAgent applicationId={appId} />
        </Suspense>
      </div>
    </>
  );
}
