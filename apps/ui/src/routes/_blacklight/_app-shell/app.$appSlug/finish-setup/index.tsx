import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  cn,
} from "@autonoma/blacklight";
import { type UploadArtifactsBody, UploadScenarioRecipeVersionsBodySchema } from "@autonoma/types";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import { FolderOpenIcon } from "@phosphor-icons/react/FolderOpen";
import { GithubLogoIcon } from "@phosphor-icons/react/GithubLogo";
import { GlobeIcon } from "@phosphor-icons/react/Globe";
import { PlayIcon } from "@phosphor-icons/react/Play";
import { SpinnerGapIcon } from "@phosphor-icons/react/SpinnerGap";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import { PreviewLogsTabs } from "components/build-logs/preview-logs-tabs";
import { useAuth } from "lib/auth";
import {
  useConfigureAndDiscoverSdkTarget,
  useConfigureAndDiscoverScenarios,
  useOnboardingScenarios,
  useOnboardingState,
  usePrepareSdkTarget,
  useRunScenarioDryRun,
  useSdkDryRunTargets,
} from "lib/onboarding/onboarding-api";
import { ensureAPIQueryData } from "lib/query/api-queries";
import {
  useArtifactStatus,
  usePrepareCliSetup,
  useUpdateSetup,
  useUploadScenarioRecipeVersions,
  useUploadSetupArtifacts,
} from "lib/query/app-generations.queries";
import { useApplicationSharedSecret } from "lib/query/applications.queries";
import { toastManager } from "lib/toast-manager";
import { trpc } from "lib/trpc";
import { type ReactNode, Suspense, useEffect, useRef, useState } from "react";
import { useCurrentApplication } from "../../-use-current-application";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/finish-setup/")({
  loader: async ({ context, params: { appSlug } }) => {
    const app = context.applications.find((a) => a.slug === appSlug);
    if (app == null) return;
    const [state] = await Promise.all([
      ensureAPIQueryData(context.queryClient, trpc.onboarding.getState.queryOptions({ applicationId: app.id })),
      ensureAPIQueryData(
        context.queryClient,
        trpc.onboarding.listSdkDryRunTargets.queryOptions({ applicationId: app.id }),
      ),
    ]);
    if (state.setupComplete) {
      throw redirect({ to: "/app/$appSlug", params: { appSlug } });
    }
  },
  component: FinishSetupPage,
});

function FinishSetupPage() {
  const app = useCurrentApplication();

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-8">
      <Link
        to="/app/$appSlug"
        params={{ appSlug: app.slug }}
        className="flex w-fit items-center gap-1.5 font-mono text-2xs uppercase tracking-widest text-text-secondary transition-colors hover:text-text-primary"
      >
        <ArrowLeftIcon size={14} />
        Back to home
      </Link>

      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-medium tracking-tight text-text-primary">Finish setup</h1>
        <p className="max-w-2xl text-sm text-text-secondary">
          Deepen what Autonoma can test - implement the SDK so it can provision real test data, upload CLI artifacts,
          and dry-run your scenarios. Finish once all three are done.
        </p>
      </header>

      <Suspense fallback={<Skeleton className="h-96 w-full" />}>
        <FinishSetupSteps applicationId={app.id} />
      </Suspense>
    </div>
  );
}

function FinishSetupSteps({ applicationId }: { applicationId: string }) {
  const { data: state } = useOnboardingState(applicationId);
  const { data: artifactStatus } = useArtifactStatus(applicationId);

  const sdkImplemented = state.sdkConfigured;
  const artifactsUploaded = state.artifactsUploaded;
  const dryRunPassed = state.dryRunPassed;

  const stepDone = [sdkImplemented, artifactsUploaded, dryRunPassed];
  const activeStepIndex = stepDone.findIndex((done) => !done);

  // BYO go-live is optimistic: the app is marked live before we ever see a PR
  // deployment signal. If the customer never wired their `deployment_status`
  // workflow, no signal arrives and `diffTriggerConfirmedAt` stays null. Surface
  // that so a live-but-silent app does not look healthy.
  const awaitingFirstDiffSignal =
    state.step === "completed" &&
    state.previewEnvironmentMode === "existing_deploys" &&
    state.diffTriggerConfirmedAt == null;

  return (
    <div className="flex flex-col">
      {awaitingFirstDiffSignal && (
        <div className="mb-6 flex items-start gap-3 border border-status-warn/30 bg-status-warn/5 px-5 py-4">
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
      <Step
        index={1}
        done={sdkImplemented}
        active={activeStepIndex === 0}
        title="Implement the Autonoma SDK"
        description={
          <>
            Autonoma calls one POST endpoint - the environment factory - to create and tear down isolated test data for
            each scenario. Mount it at the fixed convention <Code>/api/autonoma</Code>. For a PreviewKit-managed
            preview, Autonoma provisions both <Code>AUTONOMA_SHARED_SECRET</Code> and{" "}
            <Code>AUTONOMA_SIGNING_SECRET</Code> into the app for you - just read them from the environment in your
            handler (rotatable in the app's Secrets settings). Open a PR titled <Code>feat: autonoma-sdk</Code> and
            validate it against that PR's preview below, so you iterate on a branch instead of pushing to main.
            <span className="mt-2 block text-text-secondary">
              <DocLink href="https://docs.autonoma.app/guides/environment-factory">Environment Factory guide</DocLink>
              {" · "}
              <DocLink href="https://docs.autonoma.app/examples/typescript#nextjs-app-router">
                framework example
              </DocLink>
            </span>
          </>
        }
      >
        <SdkStepBody applicationId={applicationId} />
      </Step>

      <Step
        index={2}
        done={artifactsUploaded}
        active={activeStepIndex === 1}
        title="Upload test artifacts"
        description={
          <>Run the Autonoma planner CLI in your repo to upload recipes, test cases, and a knowledge base.</>
        }
      >
        <ArtifactsStepBody applicationId={applicationId} artifacts={artifactStatus} />
      </Step>

      <Step
        index={3}
        done={dryRunPassed}
        active={activeStepIndex === 2}
        title="Dry-run your scenarios"
        isLast
        description={
          <>
            Run each scenario's up/down cycle against a preview env (the auto-detected SDK PR, or main) to confirm test
            data provisions cleanly.
          </>
        }
      >
        <DryRunStepBody applicationId={applicationId} />
      </Step>

      <div className="mt-2 border-t border-border-dim pt-6">
        <p className="max-w-2xl text-sm text-text-secondary">
          All three steps are required. Until they're done, Autonoma can't run test generations for this app. The page
          closes itself once the app is set up.
        </p>
      </div>
    </div>
  );
}

function DocLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="font-medium text-primary-ink underline-offset-2 hover:underline"
    >
      {children}
    </a>
  );
}

function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-2xs text-primary-ink">{children}</code>
  );
}

function Step({
  index,
  done,
  active,
  title,
  description,
  isLast,
  children,
}: {
  index: number;
  done: boolean;
  active: boolean;
  title: string;
  description: ReactNode;
  isLast?: boolean;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(active);
  useEffect(() => {
    setExpanded(active);
  }, [active]);

  return (
    <div className="flex gap-4">
      <div className="flex flex-col items-center">
        <div
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-full border font-mono text-xs font-bold transition-colors",
            done
              ? "border-primary-ink bg-primary-ink text-surface-void"
              : "border-border-mid bg-surface-base text-text-secondary",
          )}
        >
          {done ? <CheckIcon size={15} weight="bold" /> : index}
        </div>
        {!isLast && <div className="my-1 w-px flex-1 bg-border-dim" />}
      </div>
      <div className={cn("flex-1", expanded && !isLast ? "pb-10" : "pb-6")}>
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
          className="group flex w-full items-center gap-2 text-left"
        >
          <h2 className="text-lg font-medium text-text-primary">{title}</h2>
          <CaretDownIcon
            size={14}
            className={cn(
              "text-text-secondary transition-transform group-hover:text-text-primary",
              expanded ? "" : "-rotate-90",
            )}
          />
        </button>
        <div
          className={cn(
            "grid transition-[grid-template-rows] duration-300 ease-in-out",
            expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
          )}
        >
          <div className="overflow-hidden">
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-text-secondary">{description}</p>
            <div className="mt-5">{children}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Step 1: SDK implement + validate + dry run ───────────────────────────────

/**
 * The PreviewKit env addressing (owner/repo/pr) for streaming a managed target's
 * logs. Only PreviewKit-managed targets carry a `repoFullName`; external (BYO)
 * targets have no preview env we can stream, so they resolve to undefined.
 */
function buildPreviewLogTarget(
  target: { source: string; repoFullName?: string; prNumber?: number; sdkAppName?: string } | undefined,
): { owner: string; repo: string; pr: number; app?: string } | undefined {
  if (target?.source !== "previewkit" || target.repoFullName == null || target.prNumber == null) return undefined;
  const [owner = "", repo = ""] = target.repoFullName.split("/");
  if (owner === "" || repo === "") return undefined;
  return { owner, repo, pr: target.prNumber, app: target.sdkAppName };
}

function buildPullRequestUrl(
  target: { source: string; repoFullName?: string; prNumber?: number } | undefined,
): string | undefined {
  if (target?.source !== "previewkit" || target.repoFullName == null || target.prNumber == null) return undefined;
  if (target.prNumber <= 0) return undefined;
  return `https://github.com/${target.repoFullName}/pull/${target.prNumber}`;
}

/**
 * Display label for a validation / dry-run target: "main" for the main env, and
 * "<name> #<pr>" for a PR (with a "(SDK PR)" marker on the auto-detected one).
 * Guards against a doubled number when the name is already the "PR #n" fallback.
 */
function formatTargetLabel(target: {
  kind: "main" | "pr";
  label: string;
  prNumber?: number;
  isAutoDetected: boolean;
}): string {
  if (target.kind === "main") return target.label;
  const base =
    target.prNumber != null && !target.label.includes(`#${target.prNumber}`)
      ? `${target.label} #${target.prNumber}`
      : target.label;
  return target.isAutoDetected ? `${base} (SDK PR)` : base;
}

function SdkStepBody({ applicationId }: { applicationId: string }) {
  const { data: state } = useOnboardingState(applicationId);
  const { data: targets } = useSdkDryRunTargets(applicationId);
  const sharedSecretQuery = useApplicationSharedSecret(applicationId);
  const discover = useConfigureAndDiscoverScenarios();
  const managedDiscover = useConfigureAndDiscoverSdkTarget();
  const prepareTarget = usePrepareSdkTarget();
  const prepareMutate = prepareTarget.mutate;

  const [selectedTargetId, setSelectedTargetId] = useState<string | undefined>(
    targets.autoDetectedTargetId ?? targets.targets[0]?.id,
  );
  const [signingSecret, setSigningSecret] = useState("");
  const [logsExpanded, setLogsExpanded] = useState(true);

  const serverSecret = sharedSecretQuery.data?.sharedSecret;
  useEffect(() => {
    if (serverSecret == null || serverSecret.length === 0) return;
    setSigningSecret((prev) => (prev.length === 0 ? serverSecret : prev));
  }, [serverSecret]);

  const selectedTarget = targets.targets.find((t) => t.id === selectedTargetId);
  const requiresSharedSecretInput = selectedTarget?.requiresSharedSecretInput ?? true;
  const selectedTargetSource = selectedTarget?.source;

  useEffect(() => {
    if (selectedTargetId == null || selectedTargetSource !== "previewkit") return;
    prepareMutate({ applicationId, targetId: selectedTargetId });
  }, [applicationId, selectedTargetId, selectedTargetSource, prepareMutate]);

  const preparing =
    prepareTarget.isPending ||
    (selectedTarget?.source === "previewkit" && selectedTarget.status != null && selectedTarget.status !== "ready");
  const previewLogTarget = buildPreviewLogTarget(selectedTarget);
  const pullRequestUrl = buildPullRequestUrl(selectedTarget);
  const isValidating = discover.isPending || managedDiscover.isPending || state.discoveryInProgress;
  const canDiscover =
    selectedTarget != null && !isValidating && !preparing && (!requiresSharedSecretInput || signingSecret.length > 0);

  function handleDiscover() {
    if (selectedTarget == null) return;
    if (selectedTarget.requiresSharedSecretInput) {
      discover.mutate(
        { applicationId, webhookUrl: selectedTarget.sdkUrl, signingSecret },
        { onSuccess: () => toastManager.add({ type: "success", title: "SDK endpoint reachable - schema discovered" }) },
      );
      return;
    }

    managedDiscover.mutate(
      { applicationId, targetId: selectedTarget.id },
      { onSuccess: () => toastManager.add({ type: "success", title: "SDK endpoint reachable - schema discovered" }) },
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
        <Select value={selectedTargetId ?? ""} onValueChange={(value) => setSelectedTargetId(value ?? undefined)}>
          <SelectTrigger className="max-w-lg">
            <SelectValue placeholder="Select a preview environment">
              {(value) => {
                const target = targets.targets.find((t) => t.id === value);
                return target != null ? formatTargetLabel(target) : null;
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {targets.targets.map((target) => (
              <SelectItem key={target.id} value={target.id}>
                {formatTargetLabel(target)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {selectedTarget != null && (
          <p className="font-mono text-2xs text-text-secondary">SDK endpoint: {selectedTarget.sdkUrl}</p>
        )}
        {selectedTarget?.isAutoDetected && <p className="text-2xs text-text-secondary">Auto-selected your SDK PR.</p>}
      </div>

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
      </div>

      {state.lastDiscoveryError != null && !discover.isPending && !managedDiscover.isPending && (
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-2 border border-status-critical/30 bg-status-critical/5 px-3 py-2">
            <WarningCircleIcon size={14} weight="fill" className="mt-0.5 shrink-0 text-status-critical" />
            <p className="font-mono text-2xs text-status-critical">{state.lastDiscoveryError}</p>
          </div>
          <div className="flex flex-col gap-3 border border-border-dim bg-surface-raised px-3 py-3">
            <p className="text-sm text-text-secondary">
              Autonoma reached this preview, but the SDK endpoint returned a server error. Runtime logs help when the
              SDK handler logs thrown errors; if they only show startup output, inspect the SDK route and add logging
              around the handler or discover path before re-validating.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {pullRequestUrl != null && (
                <a href={pullRequestUrl} target="_blank" rel="noopener noreferrer">
                  <Button variant="outline" size="sm" className="gap-2">
                    <GithubLogoIcon size={14} weight="bold" />
                    Open SDK PR
                  </Button>
                </a>
              )}
              {selectedTarget?.previewUrl != null && (
                <a href={selectedTarget.previewUrl} target="_blank" rel="noopener noreferrer">
                  <Button variant="outline" size="sm" className="gap-2">
                    <ArrowSquareOutIcon size={14} weight="bold" />
                    Open preview
                  </Button>
                </a>
              )}
            </div>
          </div>
          {previewLogTarget != null && (
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
                    Live output from <span className="font-medium">{selectedTarget?.label}</span>. Failed SDK requests
                    only appear here when the preview app writes the error to stdout or stderr.
                  </p>
                  <PreviewLogsTabs
                    owner={previewLogTarget.owner}
                    repo={previewLogTarget.repo}
                    pr={previewLogTarget.pr}
                    app={previewLogTarget.app}
                    appBuilding={preparing}
                  />
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Step 3: Dry run scenarios ────────────────────────────────────────────────

function DryRunStepBody({ applicationId }: { applicationId: string }) {
  return <DryRunList applicationId={applicationId} />;
}

interface DryRunResult {
  success: boolean;
  phase?: string;
  error?: string;
}

/** The dry-run error is `unknown` over the wire; render it as a readable string. */
function formatDryRunError(error: unknown): string | undefined {
  if (error == null) return undefined;
  if (typeof error === "string") return error.length > 0 ? error : undefined;
  if (error instanceof Error) return error.message;
  return JSON.stringify(error);
}

function DryRunList({ applicationId }: { applicationId: string }) {
  const { data: scenarios } = useOnboardingScenarios(applicationId);
  const { data: targets } = useSdkDryRunTargets(applicationId);
  const runDryRun = useRunScenarioDryRun();
  const [results, setResults] = useState<Record<string, DryRunResult>>({});
  const [isRunning, setIsRunning] = useState(false);
  const [selectedTargetId, setSelectedTargetId] = useState<string | undefined>(
    targets.autoDetectedTargetId ?? targets.targets.find((t) => t.kind === "main")?.id ?? targets.targets[0]?.id,
  );
  const [logsExpanded, setLogsExpanded] = useState(true);

  const list = scenarios ?? [];
  const selectedTarget = targets.targets.find((t) => t.id === selectedTargetId);
  const previewLogTarget = buildPreviewLogTarget(selectedTarget);
  const anyFailed = Object.values(results).some((result) => result.success === false);

  if (list.length === 0) return null;

  async function runAll() {
    if (selectedTargetId == null) return;
    setIsRunning(true);
    setResults({});
    for (const scenario of list) {
      try {
        const result = await new Promise<DryRunResult>((resolve, reject) => {
          runDryRun.mutate(
            { applicationId, scenarioId: scenario.id, targetId: selectedTargetId },
            {
              onSuccess: (data) =>
                resolve({ success: data.success, phase: data.phase, error: formatDryRunError(data.error) }),
              onError: (err) => reject(err),
            },
          );
        });
        setResults((prev) => ({ ...prev, [scenario.id]: result }));
      } catch {
        setResults((prev) => ({ ...prev, [scenario.id]: { success: false } }));
      }
    }
    setIsRunning(false);
  }

  return (
    <div className="flex flex-col gap-3 border-t border-border-dim pt-4">
      {targets.targets.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <Label>Run against</Label>
          <Select value={selectedTargetId ?? ""} onValueChange={(value) => setSelectedTargetId(value ?? undefined)}>
            <SelectTrigger className="max-w-lg">
              <SelectValue placeholder="Select a preview environment">
                {(value) => {
                  const target = targets.targets.find((t) => t.id === value);
                  return target != null ? formatTargetLabel(target) : null;
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {targets.targets.map((target) => (
                <SelectItem key={target.id} value={target.id}>
                  {formatTargetLabel(target)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selectedTarget != null && (
            <p className="font-mono text-2xs text-text-secondary">SDK endpoint: {selectedTarget.sdkUrl}</p>
          )}
        </div>
      )}
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-text-primary">
          Dry run {list.length} scenario{list.length === 1 ? "" : "s"}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="gap-2"
          onClick={() => void runAll()}
          disabled={isRunning || selectedTargetId == null}
        >
          <PlayIcon size={14} weight="bold" />
          {isRunning ? "Running..." : "Run dry run"}
        </Button>
      </div>
      <div className="flex flex-col gap-2">
        {list.map((scenario) => {
          const result = results[scenario.id];
          return (
            <div key={scenario.id} className="flex flex-col gap-1">
              <div className="flex items-center gap-2.5 font-mono text-2xs">
                {result == null ? (
                  <span className="size-3.5 shrink-0 rounded-full border border-border-dim" />
                ) : result.success ? (
                  <CheckCircleIcon size={14} weight="fill" className="shrink-0 text-status-success" />
                ) : (
                  <WarningCircleIcon size={14} weight="fill" className="shrink-0 text-status-critical" />
                )}
                <span className={cn(result?.success === false && "text-status-critical")}>
                  {scenario.name}
                  {result?.success === false && result.phase != null && ` - failed during ${result.phase}`}
                </span>
              </div>
              {result?.success === false && result.error != null && result.error !== "" && (
                <p className="ml-6 whitespace-pre-wrap break-words font-mono text-3xs text-status-critical/90">
                  {result.error}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {anyFailed && previewLogTarget != null && (
        <div className="flex flex-col gap-1.5 border-t border-border-dim pt-3">
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
                Live output from <span className="font-medium">{selectedTarget?.label}</span>. A dry run fails during{" "}
                <Code>up</Code> when the SDK endpoint errors provisioning data - the stack trace lands here if your
                handler logs it.
              </p>
              <PreviewLogsTabs
                owner={previewLogTarget.owner}
                repo={previewLogTarget.repo}
                pr={previewLogTarget.pr}
                app={previewLogTarget.app}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Step 2: CLI artifacts (command always shown) ─────────────────────────────

const ARTIFACT_LABELS: Record<string, string> = {
  recipe: "recipe.json",
  tests: "qa-tests/",
  kb: "AUTONOMA.md",
  scenarios: "scenarios.md",
};

interface ArtifactStatus {
  complete: boolean;
  artifacts: Array<{ key: string; received: boolean }>;
}

function ArtifactsStepBody({ applicationId, artifacts }: { applicationId: string; artifacts: ArtifactStatus }) {
  const { user, isAdmin } = useAuth();
  const { data: sharedSecretData } = useApplicationSharedSecret(applicationId);
  const setup = useCliSetup(applicationId);
  const [copied, setCopied] = useState(false);

  const sharedSecret = sharedSecretData?.sharedSecret;
  const sharedSecretEnv = sharedSecret != null ? `AUTONOMA_SHARED_SECRET=${sharedSecret} ` : "";
  const distinctIdEnv = user != null ? `AUTONOMA_DISTINCT_ID=${user.id} ` : "";
  const uploadEnv =
    setup.status === "ready" ? `AUTONOMA_API_TOKEN=${setup.apiKey} AUTONOMA_GENERATION_ID=${setup.setupId} ` : "";
  const command = `${sharedSecretEnv}${distinctIdEnv}${uploadEnv}npx @autonoma-ai/planner@latest`;

  function handleCopy() {
    void navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      toastManager.add({ type: "success", title: "Command copied" });
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="relative border border-border-dim bg-surface-raised p-3 pr-12">
        <code className="block whitespace-pre-wrap break-all font-mono text-2xs leading-relaxed text-text-secondary">
          {command}
        </code>
        <Button
          variant="ghost"
          size="icon-xs"
          className="absolute right-2 top-2 text-text-secondary hover:text-primary-ink"
          title={copied ? "Copied" : "Copy command"}
          onClick={handleCopy}
        >
          <CopyIcon size={14} />
        </Button>
      </div>
      {setup.status === "loading" && (
        <p className="font-mono text-3xs text-text-secondary">
          Preparing an upload token so the CLI can attach its artifacts...
        </p>
      )}
      {setup.status === "error" && (
        <p className="font-mono text-3xs text-status-critical">
          Couldn't prepare the upload token - the command still runs, but won't auto-upload.
        </p>
      )}

      <div className="flex flex-col gap-1.5">
        {Object.entries(ARTIFACT_LABELS).map(([key, label]) => {
          const received = artifacts.artifacts.find((a) => a.key === key)?.received === true;
          return (
            <div key={key} className="flex items-center gap-2.5 font-mono text-2xs">
              {received ? (
                <CheckCircleIcon size={14} weight="fill" className="shrink-0 text-status-success" />
              ) : (
                <span className="size-3.5 shrink-0 rounded-full border border-border-dim" />
              )}
              <span className={cn(received ? "text-text-primary" : "text-text-secondary")}>{label}</span>
            </div>
          );
        })}
      </div>

      {isAdmin && <AdminManualUpload applicationId={applicationId} setupId={setup.setupId} />}
    </div>
  );
}

/**
 * Defensively default each recipe's `validation.phase` to "ok" (the planner CLI
 * sometimes omits it). Operates on the parsed-but-unvalidated JSON so the strict
 * `UploadScenarioRecipeVersionsBodySchema.parse` below can succeed.
 */
function defaultRecipePhases(file: unknown): unknown {
  if (typeof file !== "object" || file == null || !("recipes" in file) || !Array.isArray(file.recipes)) {
    return file;
  }
  for (const recipe of file.recipes) {
    if (
      typeof recipe === "object" &&
      recipe != null &&
      "validation" in recipe &&
      typeof recipe.validation === "object" &&
      recipe.validation != null &&
      !("phase" in recipe.validation)
    ) {
      Object.assign(recipe.validation, { phase: "ok" });
    }
  }
  return file;
}

/**
 * Internal-only escape hatch for @autonoma.app admins: pick a generated
 * `~/.autonoma/<app>/` folder and upload its recipe + artifacts directly,
 * instead of running the CLI. Uses the session-authed tRPC setup mutations.
 */
function AdminManualUpload({ applicationId, setupId }: { applicationId: string; setupId?: string }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [uploadState, setUploadState] = useState<"idle" | "uploading" | "done" | "error">("idle");
  const [uploadError, setUploadError] = useState<string>();
  const [uploadedFiles, setUploadedFiles] = useState<string[]>([]);

  const uploadRecipe = useUploadScenarioRecipeVersions();
  const uploadArtifacts = useUploadSetupArtifacts();
  const updateSetup = useUpdateSetup(applicationId);

  const ready = setupId != null;

  function setInputRef(el: HTMLInputElement | null) {
    fileInputRef.current = el;
    if (el != null) {
      el.setAttribute("webkitdirectory", "");
      el.setAttribute("directory", "");
    }
  }

  async function handleFolderUpload(files: FileList) {
    if (setupId == null) return;
    setUploadState("uploading");
    setUploadError(undefined);

    try {
      const fileEntries = await readAllFiles(files);
      setUploadedFiles(fileEntries.map((f) => f.name));

      const recipeFile = fileEntries.find((f) => f.name === "recipe.json");
      if (recipeFile != null) {
        const body = UploadScenarioRecipeVersionsBodySchema.parse(defaultRecipePhases(JSON.parse(recipeFile.content)));
        await uploadRecipe.mutateAsync({ setupId, body });
      }

      const testCases = fileEntries.filter(
        (f) =>
          (f.path.startsWith("qa-tests/") || f.path.startsWith("autonoma/qa-tests/")) &&
          f.name.endsWith(".md") &&
          f.name !== "INDEX.md",
      );
      const skills = fileEntries.filter((f) => f.path.startsWith("skills/") || f.path.startsWith("autonoma/skills/"));
      const artifacts = fileEntries.filter(
        (f) => f.name === "AUTONOMA.md" || f.name === "scenarios.md" || f.name === "entity-audit.md",
      );

      const artifactsBody: UploadArtifactsBody = {};
      if (testCases.length > 0) {
        artifactsBody.testCases = testCases.map((f) => ({ name: f.name, content: f.content, folder: f.folder }));
      }
      if (skills.length > 0) {
        artifactsBody.skills = skills.map((f) => ({ name: f.name, content: f.content }));
      }
      if (artifacts.length > 0) {
        artifactsBody.artifacts = artifacts.map((f) => ({ name: f.name, content: f.content }));
      }

      if (testCases.length + skills.length + artifacts.length > 0) {
        await uploadArtifacts.mutateAsync({ setupId, body: artifactsBody });
      }

      await updateSetup.mutateAsync({ setupId, body: { status: "completed" } });

      setUploadState("done");
    } catch (err) {
      setUploadState("error");
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    }
  }

  return (
    <div className="flex flex-col gap-3 border-t border-border-dim pt-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 self-start font-mono text-3xs uppercase tracking-widest text-text-secondary transition-colors hover:text-text-primary"
      >
        <CaretDownIcon size={12} className={cn("transition-transform", open && "rotate-180")} />
        Upload manually (internal)
      </button>

      {open && (
        <div className="border border-border-dim bg-surface-base p-4">
          <input
            ref={setInputRef}
            type="file"
            className="hidden"
            onChange={(e) => {
              if (e.target.files != null && e.target.files.length > 0) {
                void handleFolderUpload(e.target.files);
              }
            }}
          />

          {uploadState === "idle" && (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={!ready}
              className="flex w-full cursor-pointer flex-col items-center gap-3 border border-dashed border-border-mid p-8 transition-colors hover:border-primary-ink hover:bg-primary-ink/5 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <FolderOpenIcon size={32} weight="duotone" className="text-text-secondary" />
              <div className="text-center">
                <p className="text-sm font-medium text-text-primary">
                  Select a <code className="font-mono text-primary-ink">~/.autonoma/your-app/</code> folder
                </p>
                <p className="mt-1 font-mono text-3xs text-text-secondary">
                  Internal shortcut - uploads recipe + artifacts for this application.
                </p>
              </div>
            </button>
          )}

          {uploadState === "uploading" && (
            <div className="flex items-center gap-3 border border-border-dim p-6">
              <SpinnerGapIcon size={20} className="animate-spin text-text-secondary" />
              <p className="text-sm text-text-secondary">Uploading artifacts...</p>
            </div>
          )}

          {uploadState === "done" && (
            <div className="flex items-center gap-3 border border-status-success/20 bg-status-success/5 p-4">
              <CheckCircleIcon size={20} weight="fill" className="text-status-success" />
              <p className="text-sm font-medium text-text-primary">
                {uploadedFiles.length} file{uploadedFiles.length !== 1 ? "s" : ""} uploaded
              </p>
            </div>
          )}

          {uploadState === "error" && (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-3 border border-status-critical/20 bg-status-critical/5 p-4">
                <WarningCircleIcon size={20} weight="fill" className="text-status-critical" />
                <div>
                  <p className="text-sm font-medium text-text-primary">Upload failed</p>
                  {uploadError != null && <p className="font-mono text-3xs text-text-secondary">{uploadError}</p>}
                </div>
              </div>
              <Button variant="outline" size="xs" onClick={() => setUploadState("idle")}>
                Try again
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface ParsedFile {
  name: string;
  path: string;
  folder?: string;
  content: string;
}

async function readAllFiles(fileList: FileList): Promise<ParsedFile[]> {
  const results: ParsedFile[] = [];
  for (const file of Array.from(fileList)) {
    const parts = file.webkitRelativePath.split("/");
    // Skip the top-level folder name (the selected directory itself).
    const pathWithinDir = parts.slice(1).join("/");
    if (pathWithinDir === "") continue;

    const content = await file.text();
    const fileName = parts[parts.length - 1] ?? file.name;
    const folderParts = parts.slice(1, -1);
    results.push({
      name: fileName,
      path: pathWithinDir,
      folder: folderParts.length > 0 ? folderParts.join("/") : undefined,
      content,
    });
  }
  return results;
}

interface CliSetupState {
  status: "loading" | "ready" | "error";
  apiKey?: string;
  setupId?: string;
}

/**
 * Mints an API key + setup once (on mount, via tRPC) so the CLI command can
 * always be shown with a working upload token. The command renders immediately;
 * the token fills in when this resolves. Errors surface through Sentry via the
 * shared mutation cache hook.
 */
function useCliSetup(applicationId: string): CliSetupState {
  const prepare = usePrepareCliSetup();
  const { mutate, isIdle, isError, data } = prepare;

  useEffect(() => {
    // Kick off once when idle; the mutation's own lifecycle is the dedupe guard.
    if (isIdle) mutate({ applicationId });
  }, [applicationId, isIdle, mutate]);

  if (isError) return { status: "error" };
  if (data != null) return { status: "ready", apiKey: data.apiKey, setupId: data.setupId };
  return { status: "loading" };
}
