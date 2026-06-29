import { Button } from "@autonoma/blacklight";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react/ArrowCounterClockwise";
import { ShieldCheckIcon } from "@phosphor-icons/react/ShieldCheck";
import { SignOutIcon } from "@phosphor-icons/react/SignOut";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { TalkToSupport } from "components/talk-to-support";
import { useAuth, useAuthClient } from "lib/auth";
import { buildOnboardingSearch } from "lib/onboarding/onboarding-search";
import { isOnboardingStep, type OnboardingStep } from "lib/onboarding/onboarding-steps";
import { useDeleteApplication } from "lib/query/applications.queries";
import { ensureSessionData } from "lib/query/auth.queries";
import { toastManager } from "lib/toast-manager";
import { trpc } from "lib/trpc";
import { Component, useState, type ReactNode } from "react";
import { StepProgress } from "./-components/step-progress";
import { AddAppPage } from "./add-app";
import { CompletePage } from "./complete";
import { DiffTriggerPage } from "./diff-trigger";
import { ExistingDeploysPage } from "./existing-deploys";
import { PreviewDeployVerifyPage } from "./preview-deploy-verify";
import { PreviewEnvironmentPage } from "./preview-environment";
import { PreviewkitConfigPage } from "./previewkit-config";

function mapBackendStepToViewStep(step: string | undefined): OnboardingStep {
  if (step === "preview_environment") return "preview-environment";
  if (step === "previewkit_configuring") return "previewkit-config";
  if (step === "existing_deploys_configuring" || step === "existing_deploys_waiting") return "existing-deploys";
  if (step === "previewkit_deploying" || step === "preview_verified") return "deploy-verify";
  if (step === "diff_trigger") return "diff-trigger";
  if (step === "completed") return "complete";
  // "github" (Add app) and any legacy SDK/CLI step start at the merged Add app step.
  return "add-app";
}

export const Route = createFileRoute("/_blacklight/onboarding")({
  component: OnboardingLayout,
  validateSearch: (search: Record<string, unknown>) => {
    const step = typeof search.step === "string" && isOnboardingStep(search.step) ? search.step : undefined;
    const appId = typeof search.appId === "string" ? search.appId : undefined;
    // A GitHub OAuth/App-install callback can redirect back here with an error.
    const error = typeof search.error === "string" ? search.error : undefined;
    // The CLI upload credentials for the setup step live in the URL (not
    // localStorage) so a refresh keeps the same setup the CLI uploads to.
    const apiKey = typeof search.apiKey === "string" ? search.apiKey : undefined;
    const setupId = typeof search.setupId === "string" ? search.setupId : undefined;
    // Deploy diagnostics deep-link back into the config form: which app card
    // (and which field) to scroll to and focus.
    const focusApp = typeof search.focusApp === "string" ? search.focusApp : undefined;
    const focusField = typeof search.focusField === "string" ? search.focusField : undefined;
    const focusSection = readFocusSection(search.focusSection);
    return { step, appId, error, apiKey, setupId, focusApp, focusField, focusSection };
  },
  loader: async ({ context: { queryClient }, location }) => {
    const session = await ensureSessionData(queryClient);
    if (session == null) throw Route.redirect({ to: "/login", search: { error: undefined } });
    const applicationId = readAppIdFromSearch(location.search);
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

function readAppIdFromSearch(search: unknown): string | undefined {
  if (typeof search !== "object" || search == null || !("appId" in search)) return undefined;
  return typeof search.appId === "string" ? search.appId : undefined;
}

function readFocusSection(value: unknown): "config" | "secrets" | "logs" | undefined {
  if (value === "config" || value === "secrets" || value === "logs") return value;
  return undefined;
}

function resolveViewStep(
  requestedStep: OnboardingStep | undefined,
  backendStep: string | undefined,
  hasApplication: boolean,
): OnboardingStep {
  const backendViewStep = mapBackendStepToViewStep(backendStep);
  if (backendStep === "completed" && hasApplication) return backendViewStep;
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

/**
 * Catches errors thrown while rendering a step - notably a suspense query that
 * rejects when a user deep-links / refreshes onto a step before its
 * prerequisites are met, or with a stale appId. Without this, the throw bubbles
 * to TanStack's default error page and replaces the whole onboarding UI. Keyed
 * by step in the layout so navigating to another step clears the error.
 */
class OnboardingStepErrorBoundary extends Component<
  { children: ReactNode; onStartOver: () => void },
  { error?: Error }
> {
  override state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override render() {
    if (this.state.error != null) {
      return (
        <div className="mx-auto flex max-w-lg flex-col items-center gap-5 border border-border-dim bg-surface-base p-10 text-center">
          <WarningCircleIcon size={28} weight="duotone" className="text-status-critical" />
          <div className="space-y-2">
            <h2 className="text-lg font-medium text-text-primary">We couldn't load this step</h2>
            <p className="font-mono text-2xs text-text-secondary">{this.state.error.message}</p>
          </div>
          <Button variant="outline" size="sm" className="gap-2" onClick={this.props.onStartOver}>
            <ArrowCounterClockwiseIcon size={14} />
            Start over
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}

function OnboardingLayout() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, isAdmin } = useAuth();
  const authClient = useAuthClient();
  const { backendStep } = Route.useLoaderData();
  const { step, appId, error, focusApp, focusField, focusSection } = Route.useSearch();
  const currentStepId = resolveViewStep(step, backendStep, appId != null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const deleteApp = useDeleteApplication();

  function goToSetup() {
    void navigate({ to: "/onboarding", search: buildOnboardingSearch("add-app") });
  }

  // Reset deletes the current (half-onboarded) app and returns to the name
  // screen to start fresh. Only navigate on success so a failed delete surfaces
  // the error instead of silently appearing to work.
  function handleReset() {
    if (appId == null) {
      goToSetup();
      setConfirmReset(false);
      return;
    }

    setIsResetting(true);
    deleteApp.mutate(
      { id: appId },
      {
        onSuccess: () => {
          goToSetup();
          setConfirmReset(false);
        },
        onError: () => {
          toastManager.add({ type: "critical", title: "Failed to reset onboarding" });
        },
        onSettled: () => {
          setIsResetting(false);
        },
      },
    );
  }

  function renderStep() {
    if (currentStepId === "add-app") return <AddAppPage appId={appId} error={error} />;
    if (currentStepId === "preview-environment") return <PreviewEnvironmentPage appId={appId} />;
    if (currentStepId === "previewkit-config")
      return (
        <PreviewkitConfigPage appId={appId} focusApp={focusApp} focusField={focusField} focusSection={focusSection} />
      );
    if (currentStepId === "existing-deploys") return <ExistingDeploysPage appId={appId} />;
    if (currentStepId === "deploy-verify") return <PreviewDeployVerifyPage appId={appId} />;
    if (currentStepId === "diff-trigger") return <DiffTriggerPage appId={appId} />;
    return <CompletePage appId={appId} />;
  }

  return (
    <div className="relative flex h-full overflow-hidden bg-surface-void">
      <GridBackground />

      <div className="fixed left-0 right-0 top-0 z-50 flex h-14 shrink-0 items-center justify-between border-b border-border-dim bg-surface-void/80 px-6 backdrop-blur">
        <img src="/logo.svg" alt="Autonoma" className="h-5 w-auto" />
        <div className="flex items-center gap-2">
          <span className="font-mono text-2xs text-text-secondary">{user?.name ?? user?.email ?? ""}</span>
          {isAdmin && (
            <Link
              to="/admin"
              className="flex items-center gap-1.5 rounded px-2 py-1 font-mono text-3xs uppercase tracking-widest text-text-secondary transition-colors hover:bg-surface-raised hover:text-text-primary"
            >
              <ShieldCheckIcon size={14} />
              Admin
            </Link>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            title="Sign out"
            className="hover:text-status-critical"
            onClick={() => {
              void authClient.signOut().then(() => {
                queryClient.clear();
                void navigate({ to: "/login", search: { error: undefined } });
              });
            }}
          >
            <SignOutIcon size={16} />
          </Button>
        </div>
      </div>

      <aside className="relative z-10 mt-14 flex w-64 shrink-0 flex-col border-r border-border-dim bg-surface-base/30 backdrop-blur-sm">
        <div className="flex-1 p-8 pt-10">
          <h3 className="mb-8 font-mono text-3xs uppercase tracking-widest text-text-secondary">New Application</h3>
          <StepProgress currentStepId={currentStepId} />
        </div>

        <div className="border-t border-border-dim px-8 py-6">
          <TalkToSupport />
        </div>

        <div className="border-t border-border-dim p-6">
          {confirmReset ? (
            <div className="space-y-3">
              <p className="font-mono text-2xs text-text-secondary">Delete this app and start over?</p>
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
          <OnboardingStepErrorBoundary key={currentStepId} onStartOver={goToSetup}>
            {renderStep()}
          </OnboardingStepErrorBoundary>
        </div>
      </main>
    </div>
  );
}
