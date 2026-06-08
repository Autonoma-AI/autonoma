import { Button } from "@autonoma/blacklight";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react/ArrowCounterClockwise";
import { SignOutIcon } from "@phosphor-icons/react/SignOut";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { TalkToSupport } from "components/talk-to-support";
import { useAuth, useAuthClient } from "lib/auth";
import { isOnboardingStep, type OnboardingStep } from "lib/onboarding/onboarding-steps";
import { ensureSessionData } from "lib/query/auth.queries";
import { trpc } from "lib/trpc";
import { useState } from "react";
import { StepProgress } from "./-components/step-progress";
import { CliSetupPage } from "./cli-setup";
import { CompletePage } from "./complete";
import { GitHubPage } from "./github";
import { DeployPage } from "./scenario-dry-run";

function mapBackendStepToViewStep(step: string | undefined): OnboardingStep {
  if (
    step === "webhook_configuring" ||
    step === "discovering" ||
    step === "discovered" ||
    step === "dry_run_passed" ||
    step === "url"
  )
    return "scenario-dry-run";
  if (step === "github") return "github";
  if (step === "completed") return "complete";
  return "cli-setup";
}

export const Route = createFileRoute("/_blacklight/onboarding")({
  component: OnboardingLayout,
  validateSearch: (search: Record<string, unknown>) => {
    const step = typeof search.step === "string" && isOnboardingStep(search.step) ? search.step : undefined;
    const appId = typeof search.appId === "string" ? search.appId : undefined;
    // The CLI upload credentials for the setup step live in the URL (not
    // localStorage) so a refresh keeps the same setup the CLI uploads to.
    const apiKey = typeof search.apiKey === "string" ? search.apiKey : undefined;
    const setupId = typeof search.setupId === "string" ? search.setupId : undefined;
    return { step, appId, apiKey, setupId };
  },
  loader: async ({ context: { queryClient }, location }) => {
    const session = await ensureSessionData(queryClient);
    if (session == null) throw Route.redirect({ to: "/login", search: { error: undefined } });
    const applicationId = (location.search as { appId?: string }).appId;
    if (applicationId == null) {
      return { backendStep: undefined };
    }
    try {
      const state = await queryClient.ensureQueryData(trpc.onboarding.getState.queryOptions({ applicationId }));
      return { backendStep: state.step };
    } catch {
      return { backendStep: undefined };
    }
  },
});

function resolveViewStep(requestedStep: OnboardingStep | undefined, backendStep: string | undefined): OnboardingStep {
  const backendViewStep = mapBackendStepToViewStep(backendStep);
  if (requestedStep == null) return backendViewStep;
  return requestedStep;
}

function GridBackground() {
  return (
    <div
      className="pointer-events-none absolute inset-0 opacity-5"
      style={{
        backgroundImage:
          "linear-gradient(var(--border-dim) 1px, transparent 1px), linear-gradient(90deg, var(--border-dim) 1px, transparent 1px)",
        backgroundSize: "60px 60px",
      }}
    />
  );
}

function OnboardingLayout() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const authClient = useAuthClient();
  const { backendStep } = Route.useLoaderData();
  const { step, appId } = Route.useSearch();
  const currentStepId = resolveViewStep(step, backendStep);
  const [confirmReset, setConfirmReset] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

  function handleReset() {
    setIsResetting(true);
    void navigate({
      to: "/onboarding",
      search: { step: "cli-setup", appId: undefined, apiKey: undefined, setupId: undefined },
    });
    setConfirmReset(false);
    setIsResetting(false);
  }

  function renderStep() {
    if (currentStepId === "cli-setup") return <CliSetupPage appId={appId} />;
    if (currentStepId === "scenario-dry-run") return <DeployPage appId={appId} />;
    if (currentStepId === "github") return <GitHubPage appId={appId} />;
    return <CompletePage />;
  }

  return (
    <div className="relative flex h-full overflow-hidden bg-surface-void">
      <GridBackground />

      <div className="fixed left-0 right-0 top-0 z-50 flex h-14 shrink-0 items-center justify-between border-b border-border-dim bg-surface-void/80 px-6 backdrop-blur">
        <img src="/logo.svg" alt="Autonoma" className="h-5 w-auto" />
        <div className="flex items-center gap-2">
          <span className="font-mono text-2xs text-text-tertiary">{user?.name ?? user?.email ?? ""}</span>
          <Button
            variant="ghost"
            size="icon-xs"
            title="Sign out"
            className="hover:text-status-critical"
            onClick={() => {
              void authClient.signOut().then(() => {
                window.location.href = "/login";
              });
            }}
          >
            <SignOutIcon size={16} />
          </Button>
        </div>
      </div>

      <aside className="relative z-10 mt-14 flex w-64 shrink-0 flex-col border-r border-border-dim bg-surface-base/30 backdrop-blur-sm">
        <div className="flex-1 p-8 pt-10">
          <h3 className="mb-8 font-mono text-3xs uppercase tracking-widest text-text-tertiary">New Application</h3>
          <StepProgress currentStepId={currentStepId} appId={appId} />
        </div>

        <div className="border-t border-border-dim px-8 py-6">
          <TalkToSupport />
        </div>

        <div className="border-t border-border-dim p-6">
          {confirmReset ? (
            <div className="space-y-3">
              <p className="font-mono text-2xs text-text-tertiary">Restart onboarding from scratch?</p>
              <div className="flex gap-2">
                <Button variant="destructive" size="xs" onClick={handleReset} disabled={isResetting}>
                  {isResetting ? "resetting..." : "confirm reset"}
                </Button>
                <Button variant="ghost" size="xs" onClick={() => setConfirmReset(false)}>
                  cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button
              variant="outline"
              size="xs"
              className="gap-2 font-mono text-3xs uppercase tracking-widest opacity-50 hover:opacity-100"
              onClick={() => setConfirmReset(true)}
            >
              <ArrowCounterClockwiseIcon size={12} />
              reset onboarding
            </Button>
          )}
        </div>
      </aside>

      <main
        className="relative z-10 mt-14 flex-1 overflow-y-auto"
        style={{
          backgroundSize: "24px 24px",
          backgroundImage: "radial-gradient(circle at center, rgba(255, 255, 255, 0.03) 1px, transparent 1px)",
        }}
      >
        <div className="mx-auto flex min-h-full w-full max-w-7xl flex-col justify-center px-6 py-10 pb-16 sm:px-10 sm:py-12 lg:px-14 lg:py-14">
          {renderStep()}
        </div>
      </main>
    </div>
  );
}
