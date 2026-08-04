import {
  Badge,
  BrailleSpinner,
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  buttonVariants,
} from "@autonoma/blacklight";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { LinkIcon } from "@phosphor-icons/react/Link";
import { PlugsIcon } from "@phosphor-icons/react/Plugs";
import { SealCheckIcon } from "@phosphor-icons/react/SealCheck";
import { SlidersHorizontalIcon } from "@phosphor-icons/react/SlidersHorizontal";
import { Navigate, createFileRoute, useNavigate } from "@tanstack/react-router";
import { NoVercelDeploymentsNotice } from "components/no-vercel-deployments-notice";
import { formatDate } from "lib/format";
import {
  useAvailableVercelProjects,
  useConfirmExistingDeploysSetup,
  useDeploymentSignalStatus,
  useLinkVercelProject,
  useRedeployVercelDeployment,
  useSelectVercelDeployment,
  useVercelDeployments,
  useVercelDeploymentStatus,
} from "lib/onboarding/onboarding-api";
import { type OnboardingSignalProvider, buildOnboardingSearch } from "lib/onboarding/onboarding-search";
import { useApplicationSharedSecret } from "lib/query/applications.queries";
import { type ReactNode, useEffect, useState } from "react";
import { DeploymentSignalSetup } from "./-components/deployment-signal-setup";
import { OnboardingPageHeader } from "./-components/onboarding-page-header";

/** Phases of the redeploy -> build -> commit flow that selects a Vercel deployment. */
type BuildPhase = "redeploying" | "building" | "committing";

const BUILD_PHASE_BUTTON_LABELS: Record<BuildPhase, string> = {
  redeploying: "Redeploying...",
  building: "Building preview...",
  committing: "Selecting...",
};

export const Route = createFileRoute("/_blacklight/onboarding/existing-deploys")({
  component: () => <Navigate to="/onboarding" search={buildOnboardingSearch("existing-deploys")} />,
});

export function ExistingDeploysPage({
  appId,
  initialProvider,
}: {
  appId?: string;
  initialProvider?: OnboardingSignalProvider;
}) {
  const navigate = useNavigate();
  const sharedSecretQuery = useApplicationSharedSecret(appId ?? "");
  const signalStatusQuery = useDeploymentSignalStatus(appId ?? "");
  const vercelProjectsQuery = useAvailableVercelProjects(appId ?? "");
  const confirmSetup = useConfirmExistingDeploysSetup();
  const [selectedProvider, setSelectedProvider] = useState<OnboardingSignalProvider>(initialProvider ?? "vercel");
  // Reported up by the deployment picker so the preview-status panel below can
  // show the build in flight instead of contradicting it with "no deployment
  // selected".
  const [buildPhase, setBuildPhase] = useState<BuildPhase | undefined>(undefined);

  // On the Vercel path, a linked project is required before continuing - without
  // it there's no protection-bypass header, so generated tests can never reach
  // the preview.
  const vercelProjectLinked = vercelProjectsQuery.data?.linkedProject != null;
  // Selecting a deployment writes the preview URL directly (see
  // `useSelectVercelDeployment`), so this is true for Vercel the moment one has
  // been picked - no CI signal required.
  const previewUrlSet = signalStatusQuery.data?.previewUrl != null;
  // Both paths need a preview URL before there is anything to verify. On the
  // custom path that URL only exists once CI has POSTed a signed signal, so
  // Continue stays locked until one lands - users otherwise click straight past
  // the wait, having never set the secret or committed the workflow.
  const canContinue = selectedProvider === "vercel" ? vercelProjectLinked && previewUrlSet : previewUrlSet;
  const isBuildingPreview = !previewUrlSet && buildPhase != null;
  // Shares the picker's query (same key), so the gate below can stop telling the
  // user to select a deployment when the picker is showing a blocker instead.
  const deploymentsQuery = useVercelDeployments(appId ?? "", selectedProvider === "vercel" && vercelProjectLinked);
  const hasNoDeployments = deploymentsQuery.data?.length === 0;
  const deploymentsLoadFailed = deploymentsQuery.isError;
  const gateState: GateState = {
    provider: selectedProvider,
    previewUrlSet,
    isBuildingPreview,
    vercelProjectLinked,
    hasNoDeployments,
    deploymentsLoadFailed,
  };

  function goToVerify() {
    void navigate({ to: "/onboarding", search: buildOnboardingSearch("deploy-verify", appId) });
  }

  function continueToVerify() {
    if (appId == null) return goToVerify();
    // Vercel already advanced the onboarding step to `preview_verified` when the
    // deployment was selected (via writePreviewUrl) - calling
    // confirmExistingDeploysSetup again would hit a state that doesn't implement
    // it. Only the custom/webhook path still needs the configuring -> waiting
    // transition.
    if (selectedProvider === "vercel") return goToVerify();
    // Mark setup as done (configuring -> waiting). The waiting state is
    // idempotent and a signal that already advanced the row to preview_verified
    // surfaces as a step-mismatch that redirects forward, so navigate regardless.
    confirmSetup.mutate({ applicationId: appId }, { onSettled: goToVerify });
  }

  function backToPreviewOptions() {
    void navigate({ to: "/onboarding", search: buildOnboardingSearch("preview-environment", appId) });
  }

  if (appId == null) {
    return <p className="font-mono text-sm text-text-secondary">No application found. Please start from setup.</p>;
  }

  return (
    <>
      <OnboardingPageHeader
        leading={
          <div className="mb-4 flex size-12 items-center justify-center border border-primary-ink/30 bg-surface-base">
            <PlugsIcon size={22} weight="duotone" className="text-primary-ink" />
          </div>
        }
        title="Connect your deploys"
        description={
          <p className="max-w-3xl">
            Keep deploying the way you do today. Autonoma only needs a signed signal when a preview URL is live.
          </p>
        }
      />

      <Button variant="ghost" size="sm" className="mb-6 w-fit gap-2" onClick={backToPreviewOptions}>
        <ArrowLeftIcon size={14} />
        Back to preview options
      </Button>

      <div className="grid gap-5 lg:grid-cols-4">
        <ProviderCard
          active={selectedProvider === "vercel"}
          icon={<VercelIcon />}
          title="Vercel"
          meta="Connect project"
          onClick={() => setSelectedProvider("vercel")}
        />
        <ProviderCard
          active={selectedProvider === "custom"}
          icon={<SlidersHorizontalIcon size={22} />}
          title="Custom"
          meta="Webhook"
          onClick={() => setSelectedProvider("custom")}
        />
        <ProviderCard icon={<PlugsIcon size={22} />} title="Netlify" meta="Soon" disabled />
        <ProviderCard icon={<PlugsIcon size={22} />} title="Render" meta="Soon" disabled />
      </div>

      {selectedProvider === "vercel" ? <VercelConnectSection appId={appId} /> : undefined}

      {selectedProvider === "vercel" && vercelProjectLinked ? (
        <VercelDeploymentPickerSection appId={appId} onPhaseChange={setBuildPhase} />
      ) : undefined}

      {selectedProvider === "custom" ? (
        <DeploymentSignalSetup applicationId={appId} sharedSecret={sharedSecretQuery.data?.sharedSecret} />
      ) : undefined}

      {selectedProvider === "vercel" ? (
        <section className="mt-6 border border-border-dim bg-surface-base p-5">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="font-mono text-sm font-bold uppercase tracking-widest text-text-primary">Preview status</h2>
            {previewUrlSet ? (
              <Badge variant="success">deployment selected</Badge>
            ) : isBuildingPreview ? (
              <Badge variant="status-running" className="gap-1.5">
                <BrailleSpinner animation="orbit" size="sm" />
                building preview
              </Badge>
            ) : (
              <Badge variant="outline">no deployment selected</Badge>
            )}
          </div>
          {signalStatusQuery.data?.previewUrl != null ? (
            <div className="mt-3 space-y-1 text-sm text-text-secondary">
              <p>
                Preview URL:{" "}
                <a
                  href={signalStatusQuery.data.previewUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-primary-ink underline-offset-4 hover:underline"
                >
                  {signalStatusQuery.data.previewUrl}
                </a>
              </p>
              {signalStatusQuery.data.acceptedAt != null ? (
                <p>Accepted {formatDate(new Date(signalStatusQuery.data.acceptedAt))}</p>
              ) : undefined}
            </div>
          ) : (
            <p className="mt-3 text-sm text-text-secondary">
              {previewStatusDetail({ isBuildingPreview, hasNoDeployments, deploymentsLoadFailed })}
            </p>
          )}
        </section>
      ) : undefined}

      {/* The gate rides in the sticky bar rather than a panel above it. It is the
          only live thing on the page and the thing that unlocks Continue, so it
          has to be readable from anywhere - and a status panel placed just above
          a sticky bar is the first thing that bar covers. */}
      <div className="sticky bottom-0 z-20 mt-8 flex flex-wrap items-center justify-between gap-4 border-t border-border-dim bg-surface-void/95 px-1 py-4 backdrop-blur">
        <div className="flex min-w-0 items-start gap-3">
          {previewUrlSet ? (
            <SealCheckIcon size={20} weight="fill" className="mt-0.5 shrink-0 text-status-success" />
          ) : (
            <BrailleSpinner animation="orbit" size="sm" className="mt-1 shrink-0 text-primary-ink" />
          )}
          <div className="min-w-0">
            <p className="text-sm font-medium text-text-primary">{gateHeadline(gateState)}</p>
            <p className="mt-0.5 max-w-2xl truncate text-2xs text-text-secondary">
              {previewUrlSet && signalStatusQuery.data?.previewUrl != null
                ? signalStatusQuery.data.previewUrl
                : gateDetail(gateState)}
            </p>
          </div>
        </div>
        <Button
          // A dimmed accent button still reads as "the yellow thing you click",
          // which is how people got past this step without ever wiring the
          // signal. While locked it drops to outline so it stops looking like
          // the action to take.
          variant={canContinue ? "accent" : "outline"}
          className="gap-2 px-6 py-3"
          disabled={confirmSetup.isPending || !canContinue}
          onClick={continueToVerify}
        >
          Continue to verify
          <ArrowRightIcon size={16} weight="bold" />
        </Button>
      </div>
    </>
  );
}

interface GateState {
  provider: OnboardingSignalProvider;
  previewUrlSet: boolean;
  isBuildingPreview: boolean;
  vercelProjectLinked: boolean;
  /** The linked Vercel project answered with an empty deployment list. */
  hasNoDeployments: boolean;
  /** The deployment list could not be read at all, so the picker is showing the failure. */
  deploymentsLoadFailed: boolean;
}

/** The one-line state of the gate, shown in the sticky bar. */
function gateHeadline({
  provider,
  previewUrlSet,
  isBuildingPreview,
  vercelProjectLinked,
  hasNoDeployments,
  deploymentsLoadFailed,
}: GateState): string {
  if (previewUrlSet) return provider === "vercel" ? "Deployment selected" : "Signal received";
  if (provider === "vercel") {
    if (!vercelProjectLinked) return "Link a Vercel project";
    if (isBuildingPreview) return "Building your preview";
    if (deploymentsLoadFailed) return "Couldn't load deployments";
    return hasNoDeployments ? "No deployment to select" : "Select a deployment";
  }
  return "Waiting for your first signal";
}

/** The supporting line under {@link gateHeadline}; replaced by the preview URL once one exists. */
function gateDetail({
  provider,
  isBuildingPreview,
  vercelProjectLinked,
  hasNoDeployments,
  deploymentsLoadFailed,
}: GateState): string {
  if (provider === "vercel") {
    if (!vercelProjectLinked) return "Continue unlocks once a project is linked and a deployment picked.";
    if (isBuildingPreview) return "This unlocks as soon as your preview finishes building.";
    if (deploymentsLoadFailed) return "Autonoma couldn't read this project's deployments - retry with Check again.";
    if (hasNoDeployments) return "Deploy the project on Vercel first - the first finished build becomes the target.";
    return "Pick a deployment above to use as the onboarding preview target.";
  }
  return "Nothing has reached the deployment signal endpoint yet - this updates on its own, no need to refresh.";
}

/** The Vercel preview-status panel's supporting line while no deployment has been picked. */
function previewStatusDetail({
  isBuildingPreview,
  hasNoDeployments,
  deploymentsLoadFailed,
}: Pick<GateState, "isBuildingPreview" | "hasNoDeployments" | "deploymentsLoadFailed">): string {
  if (isBuildingPreview) return "Waiting for the redeployed preview to finish building.";
  if (deploymentsLoadFailed) return "Autonoma couldn't read this project's deployments - retry with Check again above.";
  if (hasNoDeployments) return "Deploy the project on Vercel - the first finished build becomes the preview target.";
  return "Select a deployment above to use as the onboarding preview target.";
}

function VercelConnectSection({ appId }: { appId: string }) {
  const { data, isLoading } = useAvailableVercelProjects(appId);
  const linkProject = useLinkVercelProject();
  const [selectedProjectId, setSelectedProjectId] = useState<string | undefined>(undefined);

  function handleLink() {
    if (selectedProjectId == null) return;
    linkProject.mutate({ applicationId: appId, vercelProjectId: selectedProjectId });
  }

  return (
    <section className="mt-8 border border-border-dim bg-surface-base p-6">
      <h2 className="font-mono text-sm font-bold uppercase tracking-widest text-text-primary">
        Connect a Vercel project
      </h2>
      <p className="mt-2 max-w-2xl text-sm text-text-secondary">
        Link a Vercel project you&apos;ve already authorized to this app. Autonoma manages the deployment-protection
        bypass secret automatically, so tests can reach the preview without a manual header.
      </p>

      {isLoading ? (
        <p className="mt-4 text-sm text-text-secondary">Loading Vercel projects...</p>
      ) : data?.linkedProject != null ? (
        <div className="mt-4 flex items-center gap-2 border-l-2 border-status-success bg-status-success/10 px-4 py-3">
          <CheckCircleIcon size={16} weight="fill" className="text-status-success" />
          <p className="text-sm text-text-secondary">
            Linked to <span className="font-mono text-text-primary">{data.linkedProject.name}</span>
          </p>
        </div>
      ) : data?.connected === false ? (
        <div className="mt-5 border border-primary-ink/40 bg-surface-void p-6">
          <div className="flex items-start gap-4">
            <div className="flex size-11 shrink-0 items-center justify-center border border-primary-ink/40 text-primary-ink">
              <VercelIcon />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-lg font-medium text-text-primary">Install the Autonoma Vercel integration</h3>
              <p className="mt-2 max-w-2xl text-sm text-text-secondary">
                You don&apos;t have the integration yet. We&apos;ll set you up on the Vercel marketplace and bring you
                right back here to finish setup.
              </p>
              {data.connectUrl != null ? (
                <a
                  href={data.connectUrl}
                  className={buttonVariants({
                    variant: "accent",
                    className: "mt-5 gap-2 px-6 py-3 font-mono text-sm font-bold uppercase",
                  })}
                  aria-label="onboarding-install-vercel-integration"
                >
                  Install the Autonoma Vercel integration
                  <ArrowRightIcon size={16} weight="bold" />
                </a>
              ) : (
                <p className="mt-4 font-mono text-2xs text-text-secondary">
                  The Vercel integration URL isn&apos;t configured on this environment.
                </p>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <div className="min-w-64">
            <Select value={selectedProjectId ?? ""} onValueChange={(value) => setSelectedProjectId(value ?? undefined)}>
              <SelectTrigger>
                <SelectValue
                  placeholder={data != null && data.projects.length === 0 ? "No unlinked projects" : "Select a project"}
                />
              </SelectTrigger>
              <SelectContent>
                {data?.projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            variant="accent"
            className="gap-2"
            disabled={selectedProjectId == null || linkProject.isPending}
            onClick={handleLink}
          >
            <LinkIcon size={14} weight="bold" />
            {linkProject.isPending ? "Linking..." : "Link project"}
          </Button>
          {data?.connectUrl != null && (
            <a
              href={data.connectUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 font-mono text-2xs text-text-secondary underline-offset-2 transition-colors hover:text-primary-ink hover:underline"
            >
              Connect a new Vercel project
              <ArrowSquareOutIcon size={12} />
            </a>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * Picks a Vercel deployment and wires it as the onboarding preview target.
 * Because the `AUTONOMA_SHARED_SECRET` we inject on link only takes effect on
 * new builds, "Use this deployment" first **redeploys** the chosen deployment,
 * polls the NEW deployment until it is ready (redeploys get a new URL), then
 * commits that fresh URL as the preview target.
 */
function VercelDeploymentPickerSection({
  appId,
  onPhaseChange,
}: {
  appId: string;
  onPhaseChange: (phase: BuildPhase | undefined) => void;
}) {
  const { data: deployments, isLoading, isFetching, error, refetch } = useVercelDeployments(appId);
  // Served from the cache the parent already filled - only used to name the
  // project in the empty state.
  const { data: projects } = useAvailableVercelProjects(appId);
  const redeploy = useRedeployVercelDeployment();
  const selectDeployment = useSelectVercelDeployment();
  const [selectedDeploymentId, setSelectedDeploymentId] = useState<string | undefined>(undefined);
  // The id of the redeployed deployment we are polling for readiness. While set,
  // the status poll runs; it is cleared the moment we fire the commit so the
  // effect can't re-commit the same ready deployment.
  const [pendingDeploymentId, setPendingDeploymentId] = useState<string | undefined>(undefined);

  const statusQuery = useVercelDeploymentStatus(appId, pendingDeploymentId);
  const selectMutate = selectDeployment.mutate;
  const isReady = statusQuery.data?.ready === true;

  useEffect(() => {
    if (pendingDeploymentId == null || !isReady || selectDeployment.isPending) return;
    const readyDeploymentId = pendingDeploymentId;
    setPendingDeploymentId(undefined);
    selectMutate({ applicationId: appId, vercelDeploymentId: readyDeploymentId });
  }, [pendingDeploymentId, isReady, selectDeployment.isPending, selectMutate, appId]);

  function handleUseDeployment() {
    if (selectedDeploymentId == null) return;
    redeploy.mutate(
      { applicationId: appId, vercelDeploymentId: selectedDeploymentId },
      { onSuccess: (result) => setPendingDeploymentId(result.deploymentId) },
    );
  }

  const phase = resolveBuildPhase({
    isRedeploying: redeploy.isPending,
    isBuilding: pendingDeploymentId != null,
    isCommitting: selectDeployment.isPending,
  });
  const isBusy = phase != null;
  const buttonLabel = phase != null ? BUILD_PHASE_BUTTON_LABELS[phase] : "Use this deployment";

  useEffect(() => {
    onPhaseChange(phase);
  }, [phase, onPhaseChange]);

  return (
    <section className="mt-8 border border-border-dim bg-surface-base p-6">
      <h2 className="font-mono text-sm font-bold uppercase tracking-widest text-text-primary">Select a deployment</h2>
      <p className="mt-2 max-w-2xl text-sm text-text-secondary">
        Autonoma reads deployments straight from Vercel - pick one below and we&apos;ll redeploy it so the shared secret
        takes effect, then use the fresh deployment as the onboarding preview target. No CI wiring needed.
      </p>

      {isLoading ? (
        <p className="mt-4 text-sm text-text-secondary">Loading deployments...</p>
      ) : deployments == null || deployments.length === 0 ? (
        <NoVercelDeploymentsNotice
          className="mt-4"
          projectName={projects?.linkedProject?.name}
          errorMessage={error?.message}
          isChecking={isFetching}
          onCheckAgain={() => void refetch()}
        />
      ) : (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <div className="min-w-80">
            <Select
              value={selectedDeploymentId ?? ""}
              onValueChange={(value) => setSelectedDeploymentId(value != null && value.length > 0 ? value : undefined)}
              disabled={isBusy}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select a deployment" />
              </SelectTrigger>
              <SelectContent>
                {deployments.map((deployment) => (
                  <SelectItem key={deployment.id} value={deployment.id}>
                    {deployment.target === "production" ? "Production" : "Preview"}
                    {deployment.branch != null ? ` - ${deployment.branch}` : ""} (
                    {new Date(deployment.createdAt).toLocaleString()})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            variant="accent"
            className="gap-2"
            disabled={selectedDeploymentId == null || isBusy}
            onClick={handleUseDeployment}
          >
            <LinkIcon size={14} weight="bold" />
            {buttonLabel}
          </Button>
        </div>
      )}

      {phase != null ? (
        <div className="mt-4 flex items-center gap-3 border-l-2 border-primary-ink bg-surface-raised/40 px-4 py-3">
          <BrailleSpinner animation="orbit" size="sm" className="shrink-0 text-primary-ink" />
          <p className="text-sm text-text-secondary">
            Building your preview - this takes a couple of minutes. Keep this page open, we&apos;ll pick it up
            automatically once it&apos;s ready.
          </p>
        </div>
      ) : undefined}
    </section>
  );
}

function resolveBuildPhase({
  isRedeploying,
  isBuilding,
  isCommitting,
}: {
  isRedeploying: boolean;
  isBuilding: boolean;
  isCommitting: boolean;
}): BuildPhase | undefined {
  if (isRedeploying) return "redeploying";
  if (isBuilding) return "building";
  if (isCommitting) return "committing";
  return undefined;
}

function ProviderCard({
  active,
  disabled,
  icon,
  title,
  meta,
  onClick,
}: {
  active?: boolean;
  disabled?: boolean;
  icon: ReactNode;
  title: string;
  meta: string;
  onClick?: () => void;
}) {
  const className = active
    ? "border border-primary-ink bg-surface-base p-5 text-left"
    : disabled
      ? "border border-border-dim bg-surface-base p-5 text-left opacity-50"
      : "border border-border-dim bg-surface-base p-5 text-left transition-colors hover:border-border-highlight";

  const content = (
    <>
      <div className="text-text-secondary">{icon}</div>
      <h3 className="mt-5 text-lg font-medium text-text-primary">{title}</h3>
      <p className="mt-2 font-mono text-2xs uppercase tracking-widest text-text-secondary">
        {disabled ? "Soon" : meta}
      </p>
    </>
  );

  if (onClick == null || disabled) {
    return <div className={className}>{content}</div>;
  }

  return (
    <button type="button" className={className} onClick={onClick}>
      {content}
    </button>
  );
}

function VercelIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-6 fill-current">
      <path d="M12 4 22 20H2L12 4Z" />
    </svg>
  );
}
