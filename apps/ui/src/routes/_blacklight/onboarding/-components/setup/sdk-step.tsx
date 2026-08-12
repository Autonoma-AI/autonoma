import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
} from "@autonoma/blacklight";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react/ArrowsClockwise";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { GithubLogoIcon } from "@phosphor-icons/react/GithubLogo";
import { GlobeIcon } from "@phosphor-icons/react/Globe";
import { PlayIcon } from "@phosphor-icons/react/Play";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { RobotIcon } from "@phosphor-icons/react/Robot";
import { SpinnerGapIcon } from "@phosphor-icons/react/SpinnerGap";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { Link } from "@tanstack/react-router";
import { type PreviewLogSource, PreviewLogsTabs } from "components/build-logs/preview-logs-tabs";
import { AGENT_DIALOG_DESCRIPTION, ConnectAgentDialog } from "components/connect-agent-dialog";
import { NameTheMcpNote } from "components/name-the-mcp-note";
import { NoVercelDeploymentsNotice } from "components/no-vercel-deployments-notice";
import { AGENT_INSTRUCTIONS } from "lib/onboarding/agent-instructions";
import {
  useAvailableVercelProjects,
  useConfigureAndDiscoverSdkTarget,
  useConfigureAndDiscoverScenarios,
  useDiscoverVercelDeploymentTarget,
  useOnboardingState,
  usePrepareSdkTarget,
  useRedeploySdkDryRunTarget,
  useSdkDryRunTargets,
  useVercelDeployments,
  useVercelDeploymentStatus,
} from "lib/onboarding/onboarding-api";
import { useApplicationSharedSecret } from "lib/query/applications.queries";
import { useCommitFromGitHub } from "lib/query/github.queries";
import { toastManager } from "lib/toast-manager";
import { useEffect, useState } from "react";
import { Code } from "./prose";
import { SdkValidationErrorNote } from "./sdk-validation-error-note";
import {
  type SdkDryRunTarget,
  type SelectableTarget,
  buildPreviewLogTarget,
  buildPullRequestUrl,
  formatTargetLabel,
  matchesTargetQuery,
  targetAvailabilityNote,
} from "./targets";

/** Show the dropdown filter once the list is long enough to need one. */
const TARGET_SEARCH_THRESHOLD = 8;

export interface SdkStepProps {
  applicationId: string;
  appSlug: string;
  appName: string;
  selectedTargetId: string | undefined;
  onSelectTarget: (id: string | undefined) => void;
}

/**
 * The SDK step splits by preview provider. A Vercel-linked app validates against
 * a Vercel deployment picked from the same list the onboarding flow uses - the
 * shared secret is already injected into the project, so there is no secret to
 * paste and no PR/main target to choose. Everything else keeps the manual BYO
 * flow (paste the shared secret, pick a PR/main preview target).
 */
export function SdkStepBody(props: SdkStepProps) {
  const vercelProjects = useAvailableVercelProjects(props.applicationId);

  if (vercelProjects.isLoading) return <Skeleton className="h-40 w-full" />;
  if (vercelProjects.data?.linkedProject != null) return <VercelSdkValidationSection {...props} />;
  return <ExternalSdkStepBody {...props} />;
}

/** One-line label for a Vercel deployment in the SDK-step picker. */
function formatVercelDeploymentLabel(deployment: {
  target: "production" | "preview";
  branch?: string;
  createdAt: string;
}): string {
  const kind = deployment.target === "production" ? "Production" : "Preview";
  const branch = deployment.branch != null ? ` - ${deployment.branch}` : "";
  return `${kind}${branch} (${new Date(deployment.createdAt).toLocaleString()})`;
}

/**
 * SDK validation for a Vercel-linked app: pick a deployment from the same list
 * the onboarding flow uses and validate against it with the shared secret we
 * already injected into the project (no manual paste, no PR/main target picker).
 * A deployment built before the injection fails discover with a secret-drift 401;
 * the backend then redeploys it once and returns the new deployment id, which we
 * poll to READY and auto-retry - mirroring the managed-target self-heal.
 */
function VercelSdkValidationSection({ applicationId, appName, selectedTargetId, onSelectTarget }: SdkStepProps) {
  const { data: state } = useOnboardingState(applicationId);
  // A Vercel deployment is also listed as a dry-run target under its own id, which is where the
  // resolved `<url>/api/autonoma` endpoint lives - read it from there rather than re-deriving the
  // SDK path in the browser.
  const { data: targets } = useSdkDryRunTargets(applicationId);
  const {
    data: deployments,
    isLoading,
    isFetching,
    error,
    refetch: refetchDeployments,
  } = useVercelDeployments(applicationId);
  // Cached - SdkStepBody already read it to route to this Vercel body.
  const { data: projects } = useAvailableVercelProjects(applicationId);
  const discover = useDiscoverVercelDeploymentTarget();
  // A Vercel deployment IS the dry-run target (its id is the target id), so the
  // selection is the shared target owned by the flow - the dry-run step then runs
  // against exactly the deployment validated here. Ignore a shared target that
  // isn't one of this project's deployments (e.g. a stale/external pin) so we
  // never validate against a non-Vercel id.
  const selectedDeploymentId =
    deployments?.some((deployment) => deployment.id === selectedTargetId) === true ? selectedTargetId : undefined;
  // Set to the redeployed deployment id while a secret-drift redeploy is in
  // flight; the poll below retries discover against it (allowRedeploy: false)
  // once it is READY, then disarms so it can't loop.
  const [retryDeploymentId, setRetryDeploymentId] = useState<string | undefined>(undefined);

  const statusQuery = useVercelDeploymentStatus(applicationId, retryDeploymentId);
  const discoverMutate = discover.mutate;
  const isReady = statusQuery.data?.ready === true;
  const isRedeploying = retryDeploymentId != null;
  const isValidating = discover.isPending || state.discoveryInProgress || isRedeploying;
  const showDiscoveryError = state.lastDiscoveryError != null && !isValidating;
  const selectedVercelTarget = targets.targets.find((target) => target.id === selectedDeploymentId);

  useEffect(() => {
    if (retryDeploymentId == null || !isReady || discover.isPending) return;
    const readyDeploymentId = retryDeploymentId;
    setRetryDeploymentId(undefined);
    // The redeploy produced a fresh deployment id - make it the shared target so
    // the dry-run step runs against the redeployed preview, and refetch so it
    // appears in the picker now that it is READY.
    onSelectTarget(readyDeploymentId);
    void refetchDeployments();
    discoverMutate(
      { applicationId, vercelDeploymentId: readyDeploymentId, allowRedeploy: false },
      { onSuccess: () => toastManager.add({ type: "success", title: "SDK endpoint reachable - schema discovered" }) },
    );
  }, [
    retryDeploymentId,
    isReady,
    discover.isPending,
    discoverMutate,
    applicationId,
    onSelectTarget,
    refetchDeployments,
  ]);

  function handleValidate() {
    if (selectedDeploymentId == null) return;
    discover.mutate(
      { applicationId, vercelDeploymentId: selectedDeploymentId, allowRedeploy: true },
      {
        onSuccess: (data) => {
          if (data.status === "redeploy_started") {
            setRetryDeploymentId(data.deploymentId);
            toastManager.add({
              type: "info",
              title: "Redeploying preview to sync secrets",
              description:
                "This deployment predates the shared secret - validation retries automatically once it redeploys.",
            });
            return;
          }
          toastManager.add({ type: "success", title: "SDK endpoint reachable - schema discovered" });
        },
      },
    );
  }

  const hasDeployments = deployments != null && deployments.length > 0;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <Label>Validation target</Label>
        {isLoading ? (
          <p className="text-sm text-text-secondary">Loading deployments...</p>
        ) : !hasDeployments ? (
          <NoVercelDeploymentsNotice
            projectName={projects?.linkedProject?.name}
            errorMessage={error?.message}
            isChecking={isFetching}
            onCheckAgain={() => void refetchDeployments()}
            hint="Deploy the branch that has your SDK endpoint - that is the build this validation needs."
          />
        ) : (
          <Select
            value={selectedDeploymentId ?? ""}
            onValueChange={(value) => onSelectTarget(value != null && value.length > 0 ? value : undefined)}
            disabled={isValidating}
          >
            <SelectTrigger className="max-w-lg">
              <SelectValue placeholder="Select a Vercel deployment" />
            </SelectTrigger>
            <SelectContent>
              {deployments.map((deployment) => (
                <SelectItem key={deployment.id} value={deployment.id}>
                  {formatVercelDeploymentLabel(deployment)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <p className="font-mono text-2xs text-text-secondary">
          Autonoma validates with the <Code>AUTONOMA_SHARED_SECRET</Code> it injected into your Vercel project - no need
          to paste it.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <Button
          variant="accent"
          className="gap-2"
          onClick={handleValidate}
          disabled={selectedDeploymentId == null || isValidating}
        >
          {isValidating ? (
            <SpinnerGapIcon size={16} weight="bold" className="animate-spin" />
          ) : (
            <GlobeIcon size={16} weight="bold" />
          )}
          {isRedeploying ? "Redeploying preview..." : isValidating ? "Validating..." : "Validate SDK"}
        </Button>
        {state.sdkConfigured && (
          <span className="flex items-center gap-1.5 text-sm text-status-success">
            <CheckCircleIcon size={16} weight="fill" />
            Discovered{state.lastDiscoveredModels != null ? ` ${state.lastDiscoveredModels} models` : ""}
          </span>
        )}
      </div>

      {isRedeploying && (
        <p className="text-2xs text-text-secondary">
          Redeploying so the shared secret takes effect - this can take a couple of minutes.
        </p>
      )}

      {showDiscoveryError && state.lastDiscoveryError != null && (
        <SdkValidationErrorNote
          error={state.lastDiscoveryError}
          applicationId={applicationId}
          applicationName={appName}
          targetId={selectedVercelTarget?.id}
          sdkUrl={selectedVercelTarget?.sdkUrl}
          previewUrl={selectedVercelTarget?.previewUrl}
          targetLabel={selectedVercelTarget?.label}
        />
      )}
    </div>
  );
}

/**
 * The dropdown body for the SDK step's target selector: a "previews are per-PR"
 * hint on top (the most common confusion is a pushed branch with no PR), a
 * title/#number filter once the PR list gets long, then every target with its
 * state spelled out. Unready targets stay selectable - the SDK step is where you
 * debug a building/failed preview, so you must be able to pick one.
 */
function TargetSelectItems({ targets }: { targets: SelectableTarget[] }) {
  const [query, setQuery] = useState("");
  const showSearch = targets.length >= TARGET_SEARCH_THRESHOLD;
  const visibleTargets = showSearch ? targets.filter((target) => matchesTargetQuery(target, query)) : targets;

  return (
    <>
      {showSearch && (
        <div className="px-1 pb-1 pt-0.5">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search PRs by title or #number"
            className="h-7 text-2xs"
            // eslint-disable-next-line jsx-a11y/no-autofocus -- the popup just opened at the user's request; focusing its filter is the expected behavior
            autoFocus
            onKeyDown={(e) => {
              // Keep printable keys local to the input - the Select's typeahead
              // would otherwise hijack them and move the highlight. Arrows/Enter/
              // Escape still bubble so list navigation and closing keep working.
              const isListNavigationKey =
                e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === "Escape";
              if (!isListNavigationKey) e.stopPropagation();
            }}
          />
        </div>
      )}
      <p className="max-w-sm px-2.5 py-1.5 text-2xs text-text-secondary">
        Don't see your branch? Previews are per-PR - push your branch and open a PR.
      </p>
      <SelectSeparator />
      {visibleTargets.map((target) => {
        const note = targetAvailabilityNote(target.availability);
        return (
          <SelectItem key={target.id} value={target.id}>
            {formatTargetLabel(target)}
            {note != null && <span className="ml-1.5 text-text-secondary">- {note}</span>}
          </SelectItem>
        );
      })}
      {visibleTargets.length === 0 && (
        <p className="px-2.5 py-1.5 text-2xs text-text-secondary">No PRs match "{query.trim()}"</p>
      )}
    </>
  );
}

/**
 * The cause of the target's current build: "<prefix> <branch> @ <sha> - <commit subject>",
 * one line with overflow ellipsis and the full commit message in a tooltip. The
 * message is resolved lazily from GitHub by sha (immutable, so cached hard).
 */
function TargetBuildCause({
  applicationId,
  target,
  prefix,
}: {
  applicationId: string;
  target: SdkDryRunTarget;
  prefix: string;
}) {
  const { data: commit } = useCommitFromGitHub(applicationId, target.headSha);
  if (target.headRef == null || target.headSha == null) return null;

  const shortSha = target.headSha.slice(0, 7);
  const subject = commit?.message.split("\n")[0];
  const line = `${prefix} ${target.headRef} @ ${shortSha}${subject != null ? ` - ${subject}` : ""}`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={<p className="max-w-lg cursor-default truncate font-mono text-2xs text-text-secondary" />}
      >
        {line}
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="max-w-md whitespace-pre-wrap">
        {commit?.message ?? `${target.headRef} @ ${target.headSha}`}
      </TooltipContent>
    </Tooltip>
  );
}

function ExternalSdkStepBody({ applicationId, appSlug, appName, selectedTargetId, onSelectTarget }: SdkStepProps) {
  const { data: state } = useOnboardingState(applicationId);
  const { data: targets } = useSdkDryRunTargets(applicationId);
  const sharedSecretQuery = useApplicationSharedSecret(applicationId);
  const discover = useConfigureAndDiscoverScenarios();
  const managedDiscover = useConfigureAndDiscoverSdkTarget();
  const prepareTarget = usePrepareSdkTarget();
  const redeployTarget = useRedeploySdkDryRunTarget();
  const prepareMutate = prepareTarget.mutate;

  const [signingSecret, setSigningSecret] = useState("");
  const [customHeaders, setCustomHeaders] = useState<Array<{ key: string; value: string }>>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [logsExpanded, setLogsExpanded] = useState(true);
  const [agentDialogOpen, setAgentDialogOpen] = useState(false);
  // Follow the deploy: watch the build while the image builds, then auto-switch to
  // app logs once the pods roll out (status "deploying") or the env is ready, so
  // runtime output appears without switching tabs. A failed deploy keeps the build
  // tab (the failure marker is on the build stream). An explicit tab pick wins.
  const [logSourceOverride, setLogSourceOverride] = useState<PreviewLogSource | undefined>(undefined);
  // Set to a target id while a managed discover that 401'd is self-healing via
  // redeploy; the effect below retries discover exactly once when that target
  // returns to "ready". The retry sends allowSelfHeal=false, so a 401 that
  // survives the redeploy throws and surfaces instead of re-arming.
  const [retryDiscoverTargetId, setRetryDiscoverTargetId] = useState<string | undefined>(undefined);

  const serverSecret = sharedSecretQuery.data?.sharedSecret;
  useEffect(() => {
    if (serverSecret == null || serverSecret.length === 0) return;
    setSigningSecret((prev) => (prev.length === 0 ? serverSecret : prev));
  }, [serverSecret]);

  const selectedTarget = targets.targets.find((t) => t.id === selectedTargetId);
  const requiresSharedSecretInput = selectedTarget?.requiresSharedSecretInput ?? true;
  const selectedTargetSource = selectedTarget?.source;
  const selectedTargetAvailability = selectedTarget?.availability;
  const selectedTargetHasUrl = selectedTarget?.sdkUrl != null;

  useEffect(() => {
    if (selectedTargetId == null || selectedTargetSource !== "previewkit") return;
    // Preparing provisions secrets ahead of validation - the API rejects targets
    // with no deployed URL, and a failed deploy must not be redeployed as a
    // silent side effect of merely selecting it in the dropdown.
    if (!selectedTargetHasUrl || selectedTargetAvailability === "failed") return;
    prepareMutate({ applicationId, targetId: selectedTargetId });
  }, [
    applicationId,
    selectedTargetId,
    selectedTargetSource,
    selectedTargetHasUrl,
    selectedTargetAvailability,
    prepareMutate,
  ]);

  const managedDiscoverMutate = managedDiscover.mutate;
  const managedDiscoverPending = managedDiscover.isPending;
  useEffect(() => {
    if (retryDiscoverTargetId == null) return;
    if (selectedTarget == null || selectedTarget.id !== retryDiscoverTargetId) return;
    if (selectedTarget.source !== "previewkit" || selectedTarget.availability !== "ready") return;
    if (managedDiscoverPending) return;
    // Disarm before firing so this retry cannot re-trigger itself. allowSelfHeal
    // is false here, so the only success outcome is "discovered" - a surviving
    // 401 throws (terminal) and surfaces via the mutation's error toast.
    setRetryDiscoverTargetId(undefined);
    managedDiscoverMutate(
      { applicationId, targetId: retryDiscoverTargetId, allowSelfHeal: false },
      {
        onSuccess: () => toastManager.add({ type: "success", title: "SDK endpoint reachable - schema discovered" }),
      },
    );
  }, [retryDiscoverTargetId, selectedTarget, managedDiscoverPending, managedDiscoverMutate, applicationId]);

  const preparing =
    prepareTarget.isPending || (selectedTarget?.source === "previewkit" && selectedTarget.availability === "building");
  // App pods emit runtime logs from the service-rollout phase onward; before that
  // the interesting stream is the image build.
  const appRollingOut = selectedTarget?.status === "deploying";
  const logSource: PreviewLogSource =
    logSourceOverride ?? (selectedTarget?.availability === "ready" || appRollingOut ? "app" : "build");
  const previewLogTarget = buildPreviewLogTarget(selectedTarget);
  const pullRequestUrl = buildPullRequestUrl(selectedTarget);
  const isValidating = discover.isPending || managedDiscover.isPending || state.discoveryInProgress;
  const canDiscover =
    selectedTarget?.availability === "ready" &&
    !isValidating &&
    !preparing &&
    (!requiresSharedSecretInput || signingSecret.length > 0);
  const showDiscoveryError = state.lastDiscoveryError != null && !discover.isPending && !managedDiscover.isPending;
  // When an error surface is visible, the debug/config actions move INTO it
  // (promoted, next to Redeploy) - so the quiet row would duplicate them.
  const showErrorActions = selectedTargetAvailability === "failed" || showDiscoveryError;
  // Logs are the debugging surface: on a discovery error, but also while a
  // preview is building or after its deploy failed - the answer is in there.
  const showPreviewLogs =
    showDiscoveryError || selectedTargetAvailability === "building" || selectedTargetAvailability === "failed";

  function handleDiscover() {
    if (selectedTarget == null || selectedTarget.sdkUrl == null) return;
    if (selectedTarget.requiresSharedSecretInput) {
      const headersRecord: Record<string, string> = {};
      for (const h of customHeaders) {
        if (h.key.length > 0) headersRecord[h.key] = h.value;
      }
      const webhookHeaders = Object.keys(headersRecord).length > 0 ? headersRecord : undefined;

      discover.mutate(
        { applicationId, webhookUrl: selectedTarget.sdkUrl, signingSecret, webhookHeaders },
        { onSuccess: () => toastManager.add({ type: "success", title: "SDK endpoint reachable - schema discovered" }) },
      );
      return;
    }

    const targetId = selectedTarget.id;
    managedDiscover.mutate(
      { applicationId, targetId, allowSelfHeal: true },
      {
        onSuccess: (data) => {
          if (data.status === "redeploy_started") {
            // The API found secret drift and kicked off a redeploy (the target
            // flips off "ready"), so the "Preparing preview..." poll resumes;
            // arm the single auto-retry for when it returns to ready.
            setRetryDiscoverTargetId(targetId);
            toastManager.add({
              type: "info",
              title: "Updating preview secrets",
              description: "Redeploying the preview - validation will retry automatically once it is ready.",
            });
            return;
          }
          toastManager.add({ type: "success", title: "SDK endpoint reachable - schema discovered" });
        },
      },
    );
  }

  function handleRedeploy() {
    if (selectedTarget == null) return;
    redeployTarget.mutate(
      { applicationId, targetId: selectedTarget.id },
      {
        onSuccess: () => {
          toastManager.add({
            type: "info",
            title: "Preview deploy started",
            description: "Build logs stream below - validation unlocks once the preview is ready.",
          });
        },
      },
    );
  }

  if (targets.targets.length === 0) {
    return (
      <p className="text-sm text-text-secondary">
        No preview environments yet. Open a PR (or wait for a main preview) and a dry-run target will appear here.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <Label>Validation target</Label>
        <Select
          value={selectedTargetId ?? ""}
          onValueChange={(value) => {
            const nextTargetId = value != null && value.length > 0 ? value : undefined;
            onSelectTarget(nextTargetId);
            // A new target is a new deploy timeline - let the auto-switch drive again.
            setLogSourceOverride(undefined);
          }}
        >
          <SelectTrigger className="max-w-lg">
            <SelectValue placeholder="Select a preview environment">
              {(value) => {
                const target = targets.targets.find((t) => t.id === value);
                return target != null ? formatTargetLabel(target) : null;
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <TargetSelectItems targets={targets.targets} />
          </SelectContent>
        </Select>
        {selectedTarget?.sdkUrl != null && (
          <p className="font-mono text-2xs text-text-secondary">SDK endpoint: {selectedTarget.sdkUrl}</p>
        )}
        {selectedTarget?.availability === "building" && selectedTarget.sdkUrl == null && (
          <p className="font-mono text-2xs text-text-secondary">
            SDK endpoint will appear once the preview finishes deploying.
          </p>
        )}
        {selectedTarget?.availability === "building" && (
          <TargetBuildCause applicationId={applicationId} target={selectedTarget} prefix="Building" />
        )}
        {selectedTarget?.isAutoDetected && <p className="text-2xs text-text-secondary">Auto-selected your SDK PR.</p>}
        {selectedTargetSource === "previewkit" && selectedTargetAvailability === "ready" && (
          <div className="mt-1 flex items-center gap-2">
            <Button
              variant="outline"
              size="xs"
              className="gap-1.5"
              onClick={handleRedeploy}
              disabled={redeployTarget.isPending}
            >
              {redeployTarget.isPending ? (
                <SpinnerGapIcon size={12} className="animate-spin" />
              ) : (
                <ArrowsClockwiseIcon size={12} />
              )}
              Redeploy preview
            </Button>
            <p className="text-2xs text-text-secondary">
              Rebuilds at the latest commit with the current preview configuration.
            </p>
          </div>
        )}
      </div>

      {selectedTarget?.availability === "no_preview" && (
        <div className="flex flex-col gap-2 border border-status-warn/30 bg-status-warn/5 px-3 py-2.5">
          <div className="flex items-start gap-2">
            <WarningCircleIcon size={16} weight="fill" className="mt-0.5 shrink-0 text-status-warn" />
            <p className="text-sm text-text-secondary">
              Previews are built per pull request, and this PR has no preview environment. Draft PRs don't get preview
              builds automatically - mark the PR ready for review, push a new commit, or deploy one now.
            </p>
          </div>
          <div>
            <Button
              variant="outline"
              size="xs"
              className="gap-1.5"
              onClick={handleRedeploy}
              disabled={redeployTarget.isPending}
            >
              {redeployTarget.isPending ? (
                <SpinnerGapIcon size={12} className="animate-spin" />
              ) : (
                <PlayIcon size={12} />
              )}
              Deploy preview
            </Button>
          </div>
        </div>
      )}

      {selectedTarget?.availability === "failed" && (
        <div className="flex flex-col gap-2 border border-status-critical/30 bg-status-critical/5 px-3 py-2.5">
          <div className="flex items-start gap-2">
            <WarningCircleIcon size={16} weight="fill" className="mt-0.5 shrink-0 text-status-critical" />
            <p className="text-sm text-text-primary">This preview failed to deploy, so it can't be validated.</p>
          </div>
          <TargetBuildCause applicationId={applicationId} target={selectedTarget} prefix="Failed at" />
          {selectedTarget.error != null && selectedTarget.error !== "" && (
            <p className="whitespace-pre-wrap break-words font-mono text-2xs text-status-critical/90">
              {selectedTarget.error}
            </p>
          )}
          <p className="text-2xs text-text-secondary">
            The build logs below show what went wrong. Push a new commit or redeploy to retry - or point your coding
            agent at it and let it find the fix.
          </p>
          <div className="flex items-center gap-2">
            <Button variant="accent" size="xs" className="gap-1.5" onClick={() => setAgentDialogOpen(true)}>
              <RobotIcon size={12} weight="bold" />
              Debug with coding agent
            </Button>
            <Link to="/app/$appSlug/settings/previews" params={{ appSlug }} target="_blank">
              <Button variant="outline" size="xs" className="gap-1.5">
                <ArrowSquareOutIcon size={12} weight="bold" />
                Preview configuration
              </Button>
            </Link>
            <Button
              variant="outline"
              size="xs"
              className="ml-auto gap-1.5"
              onClick={handleRedeploy}
              disabled={redeployTarget.isPending}
            >
              {redeployTarget.isPending ? (
                <SpinnerGapIcon size={12} className="animate-spin" />
              ) : (
                <ArrowsClockwiseIcon size={12} />
              )}
              Redeploy preview
            </Button>
          </div>
        </div>
      )}

      {requiresSharedSecretInput && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="sdk-secret">Shared secret</Label>
          <Input
            id="sdk-secret"
            type="password"
            value={signingSecret}
            onChange={(e) => setSigningSecret(e.target.value)}
            placeholder="AUTONOMA_SHARED_SECRET"
            className="max-w-lg"
          />
          <p className="font-mono text-2xs text-text-secondary">
            Must match <Code>AUTONOMA_SHARED_SECRET</Code> on your deployment.
          </p>
        </div>
      )}

      {requiresSharedSecretInput && (
        <div>
          <button
            type="button"
            onClick={() => setShowAdvanced((prev) => !prev)}
            className="flex items-center gap-1.5 font-mono text-2xs text-text-secondary transition-colors hover:text-text-primary"
          >
            <CaretDownIcon size={12} className={cn("transition-transform", showAdvanced ? "rotate-0" : "-rotate-90")} />
            Advanced
          </button>

          {showAdvanced && (
            <div className="mt-3 space-y-3">
              <p className="font-mono text-2xs uppercase tracking-widest text-text-secondary">Custom Headers</p>
              <p className="text-2xs text-text-secondary">
                Sent with every discover/up/down request - useful for deployment-protection bypass tokens (e.g. Vercel,
                or a custom gateway) that would otherwise block us from reaching your endpoint.
              </p>
              {customHeaders.map((header, index) => (
                <div key={index} className="flex items-center gap-2">
                  <Input
                    type="text"
                    value={header.key}
                    onChange={(e) => {
                      const next = [...customHeaders];
                      next[index] = { ...header, key: e.target.value };
                      setCustomHeaders(next);
                    }}
                    placeholder="Header name"
                    className="flex-1"
                  />
                  <Input
                    type="text"
                    value={header.value}
                    onChange={(e) => {
                      const next = [...customHeaders];
                      next[index] = { ...header, value: e.target.value };
                      setCustomHeaders(next);
                    }}
                    placeholder="Value"
                    className="flex-1"
                  />
                  <button
                    type="button"
                    onClick={() => setCustomHeaders(customHeaders.filter((_, i) => i !== index))}
                    className="flex size-9 shrink-0 items-center justify-center text-text-secondary transition-colors hover:text-status-critical"
                  >
                    <TrashIcon size={14} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => setCustomHeaders([...customHeaders, { key: "", value: "" }])}
                className="flex items-center gap-1.5 font-mono text-2xs text-text-secondary transition-colors hover:text-primary-ink"
              >
                <PlusIcon size={12} />
                Add header
              </button>
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-3">
        <Button variant="accent" className="gap-2" onClick={handleDiscover} disabled={!canDiscover}>
          {preparing ? (
            <SpinnerGapIcon size={16} weight="bold" className="animate-spin" />
          ) : (
            <GlobeIcon size={16} weight="bold" />
          )}
          {preparing ? "Preparing preview..." : isValidating ? "Validating..." : "Validate SDK"}
        </Button>
        {state.sdkConfigured && (
          <span className="flex items-center gap-1.5 text-sm text-status-success">
            <CheckCircleIcon size={16} weight="fill" />
            Discovered{state.lastDiscoveredModels != null ? ` ${state.lastDiscoveredModels} models` : ""}
          </span>
        )}
        {!showErrorActions && (
          <div className="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => setAgentDialogOpen(true)}>
              <RobotIcon size={14} weight="bold" />
              Debug with coding agent
            </Button>
            <Link to="/app/$appSlug/settings/previews" params={{ appSlug }} target="_blank">
              <Button variant="ghost" size="sm" className="gap-1.5">
                <ArrowSquareOutIcon size={14} weight="bold" />
                Preview configuration
              </Button>
            </Link>
          </div>
        )}
      </div>

      <ConnectAgentDialog
        open={agentDialogOpen}
        onOpenChange={setAgentDialogOpen}
        applicationId={applicationId}
        title="Debug with a coding agent"
        description={AGENT_DIALOG_DESCRIPTION}
        instruction={AGENT_INSTRUCTIONS.sdk}
        capabilities={
          <>
            <NameTheMcpNote /> From your repo it validates the endpoint against a preview, reads that preview's runtime
            logs, and fixes the handler.
          </>
        }
      />

      {showDiscoveryError && state.lastDiscoveryError != null && (
        <div className="flex flex-col gap-3">
          {/* The note carries the agent handoff, so this box no longer offers one of its own -
              a preview that never answered has no handler bug for an agent to find. */}
          <SdkValidationErrorNote
            error={state.lastDiscoveryError}
            applicationId={applicationId}
            applicationName={appName}
            targetId={selectedTarget?.id}
            sdkUrl={selectedTarget?.sdkUrl}
            previewUrl={selectedTarget?.previewUrl}
            targetLabel={selectedTarget != null ? formatTargetLabel(selectedTarget) : undefined}
            pullRequestUrl={pullRequestUrl}
            repoFullName={selectedTarget?.repoFullName}
          />
          <div className="flex flex-col gap-3 border border-border-dim bg-surface-raised px-3 py-3">
            <p className="text-sm text-text-secondary">
              The preview's runtime logs help when the SDK handler logs thrown errors; if they only show startup output,
              inspect the SDK route and add logging around the handler or discover path before re-validating.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="accent" size="sm" className="gap-2" onClick={() => setAgentDialogOpen(true)}>
                <RobotIcon size={14} weight="bold" />
                Debug with coding agent
              </Button>
              <Link to="/app/$appSlug/settings/previews" params={{ appSlug }} target="_blank">
                <Button variant="outline" size="sm" className="gap-2">
                  <ArrowSquareOutIcon size={14} weight="bold" />
                  Preview configuration
                </Button>
              </Link>
              {pullRequestUrl != null && (
                <a href={pullRequestUrl} target="_blank" rel="noopener noreferrer">
                  <Button variant="outline" size="sm" className="gap-2">
                    <GithubLogoIcon size={14} weight="bold" />
                    Open SDK PR
                  </Button>
                </a>
              )}
              {selectedTarget?.previewUrl != null && (
                <Link
                  to="/preview-waiting"
                  search={{ to: selectedTarget.previewUrl }}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Button variant="outline" size="sm" className="gap-2">
                    <ArrowSquareOutIcon size={14} weight="bold" />
                    Open preview
                  </Button>
                </Link>
              )}
            </div>
          </div>
        </div>
      )}

      {previewLogTarget != null && showPreviewLogs && (
        <div className="flex flex-col gap-1.5">
          <button
            type="button"
            onClick={() => setLogsExpanded((prev) => !prev)}
            aria-expanded={logsExpanded}
            className="flex w-fit items-center gap-1.5"
          >
            <CaretDownIcon
              size={12}
              className={cn("text-text-secondary transition-transform", logsExpanded ? "" : "-rotate-90")}
            />
            <span className="font-mono text-2xs font-medium uppercase tracking-widest text-text-secondary">
              Preview runtime logs
            </span>
          </button>
          {logsExpanded && (
            <>
              <p className="text-2xs text-text-secondary">
                Live output from <span className="font-medium">{selectedTarget?.label}</span>. Failed SDK requests only
                appear here when the preview app writes the error to stdout or stderr.
              </p>
              <PreviewLogsTabs
                owner={previewLogTarget.owner}
                repo={previewLogTarget.repo}
                pr={previewLogTarget.pr}
                app={previewLogTarget.app}
                appBuilding={preparing}
                source={logSource}
                onSourceChange={setLogSourceOverride}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}
