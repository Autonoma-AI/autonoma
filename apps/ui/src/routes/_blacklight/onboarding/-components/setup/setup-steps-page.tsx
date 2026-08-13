import { Button, Skeleton } from "@autonoma/blacklight";
import { hasGoneLive } from "@autonoma/types";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useAgentSession, useOnboardingState, useSdkDryRunTargets } from "lib/onboarding/onboarding-api";
import { SETUP_STEPS, type SetupStep } from "lib/onboarding/onboarding-flow";
import { buildOnboardingSearch } from "lib/onboarding/onboarding-search";
import { ENVIRONMENT_FACTORY_GUIDE_URL, FRAMEWORK_EXAMPLE_URL } from "lib/onboarding/sdk-docs-links";
import { type SetupProgress, isSetupStepDone } from "lib/onboarding/setup-progress";
import { useArtifactStatus } from "lib/query/app-generations.queries";
import { useApplications } from "lib/query/applications.queries";
import { type ReactNode, Suspense } from "react";
import { OnboardingAppHeader } from "../onboarding-app-header";
import { AgentFinishingScreen } from "./agent-finishing-screen";
import { type ArtifactStatus, ArtifactsStepBody } from "./artifacts-step";
import { DryRunStepBody } from "./dry-run-step";
import { Code, DocLink, SettingsLink } from "./prose";
import { SdkStepBody } from "./sdk-step";
import { type SdkDryRunTargets, resolveTargetId } from "./targets";

interface SetupStepCopy {
  title: string;
  description: (appSlug: string) => ReactNode;
}

/**
 * The heading and instruction for each post-go-live step. Keyed by step so the
 * step list stays the one source of order, and every step is guaranteed copy.
 */
const SETUP_STEP_COPY: Record<SetupStep, SetupStepCopy> = {
  cli: {
    title: "Upload test artifacts",
    description: (appSlug) => (
      <>
        Run the Autonoma planner CLI in your repo. It generates your test suite and uploads it here - nothing is
        committed to your repo.
        <span className="mt-2 block text-text-secondary">
          The command below carries a key already. To run it again later, or from CI, mint one in{" "}
          <SettingsLink to="/app/$appSlug/settings/api-keys" appSlug={appSlug}>
            organization API keys
          </SettingsLink>
          .
        </span>
      </>
    ),
  },
  sdk: {
    title: "Implement the Autonoma SDK",
    description: (appSlug) => (
      <>
        Autonoma calls one POST endpoint - the environment factory - to create and tear down isolated test data for each
        scenario. Mount it at the fixed convention <Code>/api/autonoma</Code>. For a managed preview environment,
        Autonoma provisions both <Code>AUTONOMA_SHARED_SECRET</Code> and <Code>AUTONOMA_SIGNING_SECRET</Code> into the
        app for you - just read them from the environment in your handler (rotatable in the app's Secrets settings).
        Open a PR titled <Code>feat: autonoma-sdk</Code> and validate it against that PR's preview below, so you iterate
        on a branch instead of pushing to main.
        <span className="mt-2 block text-text-secondary">
          <DocLink href={ENVIRONMENT_FACTORY_GUIDE_URL}>Environment Factory guide</DocLink>
          {" · "}
          <DocLink href={FRAMEWORK_EXAMPLE_URL}>framework example</DocLink>
          {" · "}
          <SettingsLink to="/app/$appSlug/settings/api-keys" appSlug={appSlug}>
            API keys
          </SettingsLink>
        </span>
      </>
    ),
  },
  "dry-run": {
    title: "Dry-run your scenarios",
    description: () => (
      <>
        Run each scenario's up/down cycle against a preview env (the auto-detected SDK PR, or main) to confirm test data
        provisions cleanly.
      </>
    ),
  },
};

export function SetupStepsPage({ appId, step }: { appId?: string; step: SetupStep }) {
  if (appId == null) return <SetupStepsSkeleton />;
  return (
    <Suspense fallback={<SetupStepsSkeleton />}>
      <SetupSteps appId={appId} step={step} />
    </Suspense>
  );
}

function SetupStepsSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-96 w-full" />
    </div>
  );
}

function SetupSteps({ appId, step }: { appId: string; step: SetupStep }) {
  const navigate = useNavigate();
  const { data: applications } = useApplications();
  const { data: state } = useOnboardingState(appId);
  const { data: artifactStatus } = useArtifactStatus(appId);
  const { data: targets } = useSdkDryRunTargets(appId);
  const { data: agentSession } = useAgentSession(appId);

  const app = applications.find((candidate) => candidate.id === appId);

  const progress: SetupProgress = {
    // Gate the CLI step on the live artifact status (`stepComplete`), not on
    // `state.artifactsUploaded` - the latter isn't polled here, so it would lag a
    // re-upload until a manual refresh. `stepComplete` (server-computed) requires
    // the run to be complete AND every artifact received, so the user can't advance
    // to the SDK/dry-run steps with a missing recipe or tests.
    artifactsUploaded: artifactStatus.stepComplete,
    sdkConfigured: state.sdkConfigured,
    dryRunPassed: state.dryRunPassed,
  };

  function goToStep(next: SetupStep | "complete") {
    void navigate({ to: "/onboarding", search: buildOnboardingSearch(next, appId) });
  }

  // A coding agent holding the config is doing this exact work, in a terminal the
  // user can see far better than any feed here could show them - so the steps are
  // replaced rather than annotated. That also retires the CLI step while it applies:
  // that step exists only to hand out the command the agent's run already is.
  // `holder`, not `effectiveHolder`: an agent implementing the SDK in the repo goes
  // quiet for long stretches, and the staleness window would swap the screen out
  // from under a run that is very much still going. Take over is the way back.
  if (agentSession?.holder === "agent") {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <OnboardingAppHeader appId={appId} />
        <AgentFinishingScreen applicationId={appId} progress={progress} />
      </div>
    );
  }

  // BYO go-live is optimistic: the app is marked live before we ever see a PR
  // deployment signal. If the customer never wired their `deployment_status`
  // workflow, no signal arrives and `diffTriggerConfirmedAt` stays null. Surface
  // that so a live-but-silent app does not look healthy.
  const awaitingFirstDiffSignal =
    hasGoneLive(state.step) &&
    state.previewEnvironmentMode === "existing_deploys" &&
    state.diffTriggerConfirmedAt == null;

  const copy = SETUP_STEP_COPY[step];
  const stepIndex = SETUP_STEPS.indexOf(step);
  const nextStep = SETUP_STEPS[stepIndex + 1];
  const previousStep = SETUP_STEPS[stepIndex - 1];
  const stepDone = isSetupStepDone(step, progress);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <OnboardingAppHeader appId={appId} />

      {awaitingFirstDiffSignal && (
        <div className="flex items-start gap-3 border border-status-warn/30 bg-status-warn/5 px-5 py-4">
          <WarningCircleIcon size={20} weight="fill" className="mt-0.5 shrink-0 text-status-warn" />
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium text-text-primary">Waiting for your first PR deployment signal</p>
            <p className="text-sm text-text-secondary">
              This app is live, but Autonoma hasn't received a deployment signal yet. Reviews start once your{" "}
              <Code>deployment_status</Code> workflow fires on a pull request. If you haven't wired it up, no reviews
              will run.
            </p>
          </div>
        </div>
      )}

      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-medium tracking-tight text-text-primary">{copy.title}</h1>
        <p className="max-w-2xl text-sm leading-relaxed text-text-secondary">{copy.description(app?.slug ?? "")}</p>
      </header>

      <SetupStepBody
        step={step}
        appId={appId}
        appSlug={app?.slug ?? ""}
        appName={app?.name ?? ""}
        artifactStatus={artifactStatus}
        targets={targets}
      />

      <div className="mt-2 flex items-center justify-between border-t border-border-dim pt-6">
        <Button
          variant="outline"
          className="gap-2"
          disabled={previousStep == null}
          onClick={() => previousStep != null && goToStep(previousStep)}
        >
          <ArrowLeftIcon size={16} weight="bold" />
          Back
        </Button>
        <Button
          variant="accent"
          className="gap-2 px-6 font-mono text-sm font-bold uppercase"
          disabled={!stepDone}
          onClick={() => goToStep(nextStep ?? "complete")}
        >
          {nextStep != null ? "Next" : "Finish"}
          <ArrowRightIcon size={16} weight="bold" />
        </Button>
      </div>
    </div>
  );
}

interface SetupStepBodyProps {
  step: SetupStep;
  appId: string;
  appSlug: string;
  appName: string;
  artifactStatus: ArtifactStatus;
  targets: SdkDryRunTargets;
}

/**
 * Renders the current step's body, and owns the preview target the SDK and dry-run
 * steps share.
 *
 * The target lives in the URL rather than in state here because the steps are
 * separate screens now: component state would reset on every Back/Next (and on a
 * refresh), each step would recompute its own default, and the dry run could end up
 * hitting a different preview than the one that was validated.
 */
function SetupStepBody({ step, appId, appSlug, appName, artifactStatus, targets }: SetupStepBodyProps) {
  const navigate = useNavigate();
  const { target: pinnedTargetId, setupId } = useSearch({ from: "/_blacklight/onboarding" });
  const selectedTargetId = resolveTargetId(pinnedTargetId, targets);

  // Both pins are spelled out on every write. A partial update would have to merge
  // with the live search, and `target: undefined` is a real value here - the user
  // clearing the selection - which a merge cannot tell from "leave it alone".
  function pinSearch(next: { setupId?: string; target?: string }) {
    void navigate({ to: "/onboarding", search: buildOnboardingSearch(step, appId, next), replace: true });
  }

  if (step === "cli") {
    return (
      <ArtifactsStepBody
        applicationId={appId}
        artifacts={artifactStatus}
        pinnedSetupId={setupId}
        onSetupIdResolved={(resolved) => pinSearch({ setupId: resolved, target: pinnedTargetId })}
      />
    );
  }

  if (step === "sdk") {
    return (
      <SdkStepBody
        applicationId={appId}
        appSlug={appSlug}
        appName={appName}
        selectedTargetId={selectedTargetId}
        onSelectTarget={(id) => pinSearch({ setupId, target: id })}
      />
    );
  }

  return <DryRunStepBody applicationId={appId} selectedTargetId={selectedTargetId} />;
}
