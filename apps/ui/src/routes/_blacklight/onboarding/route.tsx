import { Button } from "@autonoma/blacklight";
import { hasGoneLive } from "@autonoma/types";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react/ArrowCounterClockwise";
import { HeadsetIcon } from "@phosphor-icons/react/Headset";
import { ShieldCheckIcon } from "@phosphor-icons/react/ShieldCheck";
import { SignOutIcon } from "@phosphor-icons/react/SignOut";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { DemoReturnButton } from "components/demo-return-button";
import { SUPPORT_URL } from "components/talk-to-support";
import { useAuth, useAuthClient } from "lib/auth";
import { manageUrlSchema } from "lib/github-install-errors";
import { isConfigStepId } from "lib/onboarding/config-steps";
import { useOnboardingStateOptional } from "lib/onboarding/onboarding-api";
import {
  isOnboardingViewStep,
  isSetupStep,
  type OnboardingViewStep,
  resolveStep,
} from "lib/onboarding/onboarding-flow";
import { buildOnboardingSearch } from "lib/onboarding/onboarding-search";
import { type SetupProgress, firstIncompleteSetupStep, isSetupStepReachable } from "lib/onboarding/setup-progress";
import { useDeleteApplication } from "lib/query/applications.queries";
import { ensureSessionData } from "lib/query/auth.queries";
import { toastManager } from "lib/toast-manager";
import { trpc } from "lib/trpc";
import { Component, useState, type ReactNode } from "react";
import { FlowProgress } from "./-components/flow-progress";
import { SetupStepsPage } from "./-components/setup/setup-steps-page";
import { AddAppPage } from "./add-app";
import { CompletePage } from "./complete";
import { ExistingDeploysPage } from "./existing-deploys";
import { PreviewDeployVerifyPage } from "./preview-deploy-verify";
import { PreviewEnvironmentPage } from "./preview-environment";
import { PreviewkitConfigPage } from "./previewkit-config";

/**
 * What the flow still has to do once the app is live. Going live is the last thing
 * the persisted `step` column records, so everything after it is resolved from
 * these derived flags instead.
 */
interface SetupState extends SetupProgress {
  setupComplete: boolean;
}

export const Route = createFileRoute("/_blacklight/onboarding")({
  component: OnboardingLayout,
  validateSearch: (search: Record<string, unknown>) => {
    const step = typeof search.step === "string" && isOnboardingViewStep(search.step) ? search.step : undefined;
    const appId = typeof search.appId === "string" ? search.appId : undefined;
    // A GitHub OAuth/App-install callback can redirect back here with an error. An install
    // conflict also names both GitHub accounts, so the message can say which is which.
    const error = typeof search.error === "string" ? search.error : undefined;
    const account = typeof search.account === "string" ? search.account : undefined;
    const attempted = typeof search.attempted === "string" ? search.attempted : undefined;
    const manageUrl = manageUrlSchema.parse(search.manageUrl);
    // The CLI upload credentials for the setup step live in the URL (not
    // localStorage) so a refresh keeps the same setup the CLI uploads to.
    const apiKey = typeof search.apiKey === "string" ? search.apiKey : undefined;
    const setupId = typeof search.setupId === "string" ? search.setupId : undefined;
    // The preview the SDK step validated, so the dry-run step runs against that
    // same environment and a refresh restores it.
    const target = typeof search.target === "string" ? search.target : undefined;
    // Deploy diagnostics deep-link back into the config form: which app card
    // (and which field) to scroll to and focus.
    const focusApp = typeof search.focusApp === "string" ? search.focusApp : undefined;
    const focusField = typeof search.focusField === "string" ? search.focusField : undefined;
    const focusSection = readFocusSection(search.focusSection);
    // The active PreviewKit config sub-step, mirrored here so the sidebar reflects it.
    const configStep =
      typeof search.configStep === "string" && isConfigStepId(search.configStep) ? search.configStep : undefined;
    // Which host tab the existing-deploys step opens on, carried from the routing quiz.
    const provider = search.provider === "vercel" || search.provider === "custom" ? search.provider : undefined;
    // How the user entered onboarding; "vercel" (from the marketplace) streamlines the preview steps.
    const origin = search.origin === "vercel" ? "vercel" : undefined;
    // Opt out of the coding-agent headline on the preview step and answer the
    // routing questionnaire by hand.
    const manual = search.manual === true || search.manual === "true" ? true : undefined;
    return {
      step,
      appId,
      error,
      account,
      attempted,
      manageUrl,
      apiKey,
      setupId,
      target,
      focusApp,
      focusField,
      focusSection,
      configStep,
      provider,
      origin,
      manual,
    };
  },
  loader: async ({ context: { queryClient }, location }) => {
    const session = await ensureSessionData(queryClient);
    if (session == null) throw Route.redirect({ to: "/login", search: { error: undefined } });
    const applicationId = readAppIdFromSearch(location.search);
    if (applicationId == null) {
      return { backendStep: undefined, setup: undefined };
    }
    try {
      const state = await queryClient.ensureQueryData(trpc.onboarding.getState.queryOptions({ applicationId }));
      const setup: SetupState = {
        artifactsUploaded: state.artifactsUploaded,
        sdkConfigured: state.sdkConfigured,
        dryRunPassed: state.dryRunPassed,
        setupComplete: state.setupComplete,
      };
      return { backendStep: state.step, setup };
    } catch {
      return { backendStep: undefined, setup: undefined };
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

/**
 * Which screen the flow is on.
 *
 * Everything up to go-live comes from the persisted backend step. After it, the
 * backend has nothing left to say - `completed` means live, and the remaining work
 * (upload, SDK, dry run) is tracked as derived flags - so the step is the first one
 * of those still outstanding. A requested step is honoured only where it is a step
 * the user has actually reached, so a stale or hand-typed `?step=` cannot skip work
 * the later steps depend on.
 */
function resolveViewStep(
  requestedStep: OnboardingViewStep | undefined,
  backendStep: string | undefined,
  setup: SetupState | undefined,
  hasApplication: boolean,
): OnboardingViewStep {
  const backendViewStep = resolveStep(backendStep);
  if (!hasGoneLive(backendStep) || !hasApplication) return requestedStep ?? backendViewStep;
  if (setup == null || setup.setupComplete) return "complete";

  const nextSetupStep = firstIncompleteSetupStep(setup);
  if (nextSetupStep == null) return "complete";
  if (requestedStep != null && isSetupStep(requestedStep) && isSetupStepReachable(requestedStep, setup)) {
    return requestedStep;
  }
  return nextSetupStep;
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
 * to TanStack's default error page and replaces the whole onboarding UI.
 *
 * Recovers only by remounting - there is no reset path - so the layout keys it on
 * both the step and a retry counter: navigating to another step clears the error,
 * and so does "Try again" when the retry lands back on the same step.
 */
class OnboardingStepErrorBoundary extends Component<{ children: ReactNode; onRetry: () => void }, { error?: Error }> {
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
          <Button variant="outline" size="sm" className="gap-2" onClick={this.props.onRetry}>
            <ArrowCounterClockwiseIcon size={14} />
            Try again
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
  const { backendStep: loadedStep, setup: loadedSetup } = Route.useLoaderData();
  const {
    step,
    appId,
    error,
    account,
    attempted,
    manageUrl,
    focusApp,
    focusField,
    focusSection,
    configStep,
    provider,
    origin,
    manual,
  } = Route.useSearch();
  // useSearch widens the enums to `string`; re-narrow for the typed props.
  const initialProvider = provider === "vercel" || provider === "custom" ? provider : undefined;
  const onboardingOrigin = origin === "vercel" ? "vercel" : undefined;
  // The loader answers this once per navigation, but what it answers with keeps changing after
  // the page has loaded: an agent finishes the SDK and the dry run in a terminal, and the flow
  // has to leave on its own when they land. So the loader's value is the first paint, and the
  // polled query takes over as soon as it has one.
  const liveState = useOnboardingStateOptional(appId ?? "");
  const backendStep = liveState.data?.step ?? loadedStep;
  const setup: SetupState | undefined =
    liveState.data == null
      ? loadedSetup
      : {
          artifactsUploaded: liveState.data.artifactsUploaded,
          sdkConfigured: liveState.data.sdkConfigured,
          dryRunPassed: liveState.data.dryRunPassed,
          setupComplete: liveState.data.setupComplete,
        };
  const currentStepId = resolveViewStep(step, backendStep, setup, appId != null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  // Part of the error boundary's key. The boundary clears its error only by
  // remounting, and a retry usually resolves back to the step that threw, so the
  // step id alone would leave the key unchanged and the retry would do nothing.
  const [retryNonce, setRetryNonce] = useState(0);
  const deleteApp = useDeleteApplication();

  function goToSetup() {
    void navigate({ to: "/onboarding", search: buildOnboardingSearch("add-app") });
  }

  // Retry the step that threw. Keeping `appId` (and letting the step fall back to
  // the persisted backend step) is what makes this a resume: dropping it lands on
  // "add-app" with no application in context, where the create branch asks the user
  // to make a second application and offers to delete the one they already have.
  function retryCurrentStep() {
    setRetryNonce((nonce) => nonce + 1);
    if (appId == null) {
      goToSetup();
      return;
    }
    void navigate({ to: "/onboarding", search: buildOnboardingSearch(undefined, appId) });
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
    if (currentStepId === "add-app")
      return (
        <AddAppPage
          appId={appId}
          error={error}
          account={account}
          attempted={attempted}
          manageUrl={manageUrl}
          origin={onboardingOrigin}
        />
      );
    if (currentStepId === "preview-environment")
      return <PreviewEnvironmentPage appId={appId} origin={onboardingOrigin} manual={manual === true} />;
    if (currentStepId === "previewkit-config")
      return (
        <PreviewkitConfigPage
          appId={appId}
          focusApp={focusApp}
          focusField={focusField}
          focusSection={focusSection}
          configStep={configStep}
        />
      );
    if (currentStepId === "existing-deploys")
      return <ExistingDeploysPage appId={appId} initialProvider={initialProvider} />;
    if (currentStepId === "deploy-verify") return <PreviewDeployVerifyPage appId={appId} />;
    if (isSetupStep(currentStepId)) return <SetupStepsPage appId={appId} step={currentStepId} />;
    return <CompletePage appId={appId} />;
  }

  return (
    <div className="relative flex h-full overflow-hidden bg-surface-void">
      <GridBackground />

      {/* Onboarding is one flow with no way out until it is done, so this bar is all
          the chrome there is: where you are, how to get help, and how to start over.
          There is deliberately no app navigation - leaving half-configured is what
          used to make the product look broken. */}
      <div className="fixed left-0 right-0 top-0 z-50 flex h-14 shrink-0 items-center justify-between gap-6 border-b border-border-dim bg-surface-void/80 px-6 backdrop-blur">
        <img src="/logo.svg" alt="Autonoma" className="h-5 w-auto shrink-0" />

        <div className="hidden min-w-0 justify-center overflow-x-auto md:flex">
          <FlowProgress currentStepId={currentStepId} />
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <DemoReturnButton />
          {confirmReset ? (
            <div className="flex items-center gap-2">
              <span className="font-mono text-2xs text-text-secondary">Delete this app and start over?</span>
              <Button variant="destructive" size="xs" onClick={handleReset} disabled={isResetting}>
                {isResetting ? "resetting..." : "confirm reset"}
              </Button>
              <Button variant="ghost" size="xs" onClick={() => setConfirmReset(false)}>
                cancel
              </Button>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="xs"
              className="gap-1.5 font-mono text-3xs uppercase tracking-widest text-text-secondary"
              onClick={() => setConfirmReset(true)}
            >
              <ArrowCounterClockwiseIcon size={12} />
              reset
            </Button>
          )}
          <a href={SUPPORT_URL} target="_blank" rel="noopener noreferrer">
            <Button variant="outline" size="xs" className="gap-1.5">
              <HeadsetIcon size={14} weight="duotone" />
              Talk to support
            </Button>
          </a>
          <span className="hidden font-mono text-2xs text-text-secondary lg:inline">
            {user?.name ?? user?.email ?? ""}
          </span>
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

      <main
        className="relative z-10 mt-14 flex-1 overflow-y-auto"
        style={{
          backgroundSize: "24px 24px",
          backgroundImage: "radial-gradient(circle at center, rgba(255, 255, 255, 0.03) 1px, transparent 1px)",
        }}
      >
        <div className="mx-auto flex min-h-full w-full max-w-7xl flex-col justify-center px-6 py-10 pb-16 sm:px-10 sm:py-12 lg:px-14 lg:py-14">
          <OnboardingStepErrorBoundary key={`${currentStepId}:${retryNonce}`} onRetry={retryCurrentStep}>
            {renderStep()}
          </OnboardingStepErrorBoundary>
        </div>
      </main>
    </div>
  );
}
