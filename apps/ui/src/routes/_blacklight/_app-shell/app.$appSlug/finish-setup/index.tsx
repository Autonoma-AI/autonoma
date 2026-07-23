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
import { type UploadArtifactsBody, UploadScenarioRecipeVersionsBodySchema } from "@autonoma/types";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react/ArrowsClockwise";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import { FolderOpenIcon } from "@phosphor-icons/react/FolderOpen";
import { GithubLogoIcon } from "@phosphor-icons/react/GithubLogo";
import { GlobeIcon } from "@phosphor-icons/react/Globe";
import { PlayIcon } from "@phosphor-icons/react/Play";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { RobotIcon } from "@phosphor-icons/react/Robot";
import { SpinnerGapIcon } from "@phosphor-icons/react/SpinnerGap";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import { type PreviewLogSource, PreviewLogsTabs } from "components/build-logs/preview-logs-tabs";
import { ConnectAgentDialog, DEBUG_MCP_DOCS_URL } from "components/connect-agent-dialog";
import { useAuth } from "lib/auth";
import {
  useAvailableVercelProjects,
  useConfigureAndDiscoverSdkTarget,
  useConfigureAndDiscoverScenarios,
  useDiscoverVercelDeploymentTarget,
  useOnboardingScenarios,
  useOnboardingState,
  usePrepareSdkTarget,
  useRedeploySdkDryRunTarget,
  useRunScenarioDryRun,
  useSdkDryRunTargets,
  useVercelDeployments,
  useVercelDeploymentStatus,
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
import { useCommitFromGitHub } from "lib/query/github.queries";
import { toastManager } from "lib/toast-manager";
import { type RouterOutputs, trpc } from "lib/trpc";
import { type ReactNode, Suspense, useEffect, useRef, useState } from "react";
import { useCurrentApplication } from "../../-use-current-application";

type FinishStepId = "cli" | "sdk" | "dry-run";

interface FinishStepRenderProps {
  applicationId: string;
  artifactStatus: ArtifactStatus;
  selectedTargetId: string | undefined;
  onSelectTarget: (id: string | undefined) => void;
}

interface FinishStepDefinition {
  id: FinishStepId;
  stepperLabel: string;
  title: string;
  description: ReactNode;
  render: (props: FinishStepRenderProps) => ReactNode;
}

const CLI_FINISH_STEP: FinishStepDefinition = {
  id: "cli",
  stepperLabel: "CLI",
  title: "Upload test artifacts",
  description: <>Run the Autonoma planner CLI in your repo to upload recipes, test cases, and a knowledge base.</>,
  render: (props) => <ArtifactsStepBody applicationId={props.applicationId} artifacts={props.artifactStatus} />,
};

const SDK_FINISH_STEP: FinishStepDefinition = {
  id: "sdk",
  stepperLabel: "SDK",
  title: "Implement the Autonoma SDK",
  description: (
    <>
      Autonoma calls one POST endpoint - the environment factory - to create and tear down isolated test data for each
      scenario. Mount it at the fixed convention <Code>/api/autonoma</Code>. For a managed preview environment, Autonoma
      provisions both <Code>AUTONOMA_SHARED_SECRET</Code> and <Code>AUTONOMA_SIGNING_SECRET</Code> into the app for you
      - just read them from the environment in your handler (rotatable in the app's Secrets settings). Open a PR titled{" "}
      <Code>feat: autonoma-sdk</Code> and validate it against that PR's preview below, so you iterate on a branch
      instead of pushing to main.
      <span className="mt-2 block text-text-secondary">
        <DocLink href="https://docs.autonoma.app/guides/environment-factory">Environment Factory guide</DocLink>
        {" · "}
        <DocLink href="https://docs.autonoma.app/examples/typescript#nextjs-app-router">framework example</DocLink>
      </span>
    </>
  ),
  render: (props) => (
    <SdkStepBody
      applicationId={props.applicationId}
      selectedTargetId={props.selectedTargetId}
      onSelectTarget={props.onSelectTarget}
    />
  ),
};

const DRY_RUN_FINISH_STEP: FinishStepDefinition = {
  id: "dry-run",
  stepperLabel: "Dry run",
  title: "Dry-run your scenarios",
  description: (
    <>
      Run each scenario's up/down cycle against a preview env (the auto-detected SDK PR, or main) to confirm test data
      provisions cleanly.
    </>
  ),
  render: (props) => <DryRunStepBody applicationId={props.applicationId} selectedTargetId={props.selectedTargetId} />,
};

const FINISH_STEPS = [CLI_FINISH_STEP, SDK_FINISH_STEP, DRY_RUN_FINISH_STEP];

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/finish-setup/")({
  // Persist the CLI setup id (the planner's AUTONOMA_GENERATION_ID) in the URL so a
  // refresh reuses the same setup instead of minting a new one - which used to churn
  // the generation id and reset the CLI step's progress. `target` pins the chosen
  // dry-run target (`main` / `pr-<n>`) so an explicit pick on the SDK step carries
  // into the dry-run step (and survives refresh); it falls back to the default when
  // the target is gone (PR closed, preview torn down).
  validateSearch: (search: Record<string, unknown>): { setup?: string; target?: string } => ({
    setup: typeof search.setup === "string" ? search.setup : undefined,
    target: typeof search.target === "string" ? search.target : undefined,
  }),
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
          Deepen what Autonoma can test - upload CLI artifacts, implement the SDK so it can provision real test data,
          and dry-run your scenarios. Finish once all three are done.
        </p>
      </header>

      <Suspense fallback={<Skeleton className="h-96 w-full" />}>
        <FinishSetupSteps applicationId={app.id} appSlug={app.slug} />
      </Suspense>
    </div>
  );
}

function FinishSetupSteps({ applicationId, appSlug }: { applicationId: string; appSlug: string }) {
  const { data: state } = useOnboardingState(applicationId);
  const { data: artifactStatus } = useArtifactStatus(applicationId);
  const { data: targets } = useSdkDryRunTargets(applicationId);
  const { target: pinnedTargetId } = Route.useSearch();
  const navigate = Route.useNavigate();

  // The dry-run target is owned here, not inside a step, because the step bodies
  // mount and unmount as you move between steps - local state would reset (the
  // selection cleared on Back) and each step would recompute its own default, so
  // the dry run could hit a different preview than the one validated. Seed from
  // the URL pin (survives refresh), else the auto-detected SDK PR, else the first
  // ready preview. Keep the pin in sync so a refresh restores the same target.
  const [selectedTargetId, setSelectedTargetId] = useState<string | undefined>(() =>
    resolveInitialTargetId(pinnedTargetId, targets, targets.autoDetectedTargetId ?? pickInitialDryRunTargetId(targets)),
  );
  useEffect(() => {
    void navigate({ search: (prev) => ({ ...prev, target: selectedTargetId }), replace: true });
  }, [selectedTargetId, navigate]);

  const sdkImplemented = state.sdkConfigured;
  // Gate the CLI step on the live artifact status (`stepComplete`), not on
  // `state.artifactsUploaded` - the latter isn't polled here, so it would lag a
  // re-upload until a manual refresh. `stepComplete` (server-computed) requires the
  // run to be complete AND every artifact received, so the user can't advance to the
  // SDK/dry-run steps with a missing recipe or tests.
  const artifactsUploaded = artifactStatus.stepComplete;
  const dryRunPassed = state.dryRunPassed;

  const stepDone = [artifactsUploaded, sdkImplemented, dryRunPassed];
  const incompleteStepIndex = stepDone.findIndex((done) => done !== true);
  const firstIncompleteIndex = incompleteStepIndex === -1 ? 0 : incompleteStepIndex;
  const [currentIndex, setCurrentIndex] = useState(firstIncompleteIndex);
  const currentStep = getFinishStep(currentIndex);
  const currentStepDone = stepDone[currentIndex] === true;
  const isLastStep = currentIndex === FINISH_STEPS.length - 1;
  const completedStepCount = stepDone.filter((done) => done === true).length;

  function goToStep(index: number) {
    const step = getOptionalFinishStep(index);
    if (step == null) return;
    setCurrentIndex(index);
  }

  function goHome() {
    void navigate({ to: "/app/$appSlug", params: { appSlug } });
  }

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
      <FinishSetupStepper
        currentIndex={currentIndex}
        completedStepCount={completedStepCount}
        stepDone={stepDone}
        firstIncompleteIndex={firstIncompleteIndex}
        onSelect={goToStep}
      />

      <section className="flex flex-col gap-5">
        <header className="flex flex-col gap-2">
          <h2 className="text-lg font-medium text-text-primary">{currentStep.title}</h2>
          <p className="max-w-2xl text-sm leading-relaxed text-text-secondary">{currentStep.description}</p>
        </header>
        {currentStep.render({ applicationId, artifactStatus, selectedTargetId, onSelectTarget: setSelectedTargetId })}
      </section>

      <div className="mt-8 flex items-center justify-between border-t border-border-dim pt-6">
        <Button
          variant="outline"
          className="gap-2"
          disabled={currentIndex === 0}
          onClick={() => goToStep(currentIndex - 1)}
        >
          <ArrowLeftIcon size={16} weight="bold" />
          Back
        </Button>
        {isLastStep ? (
          <Button
            variant="accent"
            className="gap-2 px-6 font-mono text-sm font-bold uppercase"
            disabled={!currentStepDone}
            onClick={goHome}
          >
            Finish
            <ArrowRightIcon size={16} weight="bold" />
          </Button>
        ) : (
          <Button
            variant="accent"
            className="gap-2 px-6 font-mono text-sm font-bold uppercase"
            disabled={!currentStepDone}
            onClick={() => goToStep(currentIndex + 1)}
          >
            Next
            <ArrowRightIcon size={16} weight="bold" />
          </Button>
        )}
      </div>

      <div className="mt-2 border-t border-border-dim pt-6">
        <p className="max-w-2xl text-sm text-text-secondary">
          All three steps are required. Until they're done, Autonoma can't run test generations for this app. The page
          closes itself once the app is set up.
        </p>
      </div>
    </div>
  );
}

function getFinishStep(index: number): FinishStepDefinition {
  if (index === 0) return CLI_FINISH_STEP;
  if (index === 1) return SDK_FINISH_STEP;
  return DRY_RUN_FINISH_STEP;
}

function getOptionalFinishStep(index: number): FinishStepDefinition | undefined {
  if (index === 0) return CLI_FINISH_STEP;
  if (index === 1) return SDK_FINISH_STEP;
  if (index === 2) return DRY_RUN_FINISH_STEP;
  return undefined;
}

function FinishSetupStepper({
  currentIndex,
  completedStepCount,
  stepDone,
  firstIncompleteIndex,
  onSelect,
}: {
  currentIndex: number;
  completedStepCount: number;
  stepDone: boolean[];
  firstIncompleteIndex: number;
  onSelect: (index: number) => void;
}) {
  return (
    <section className="mb-6 border border-border-dim bg-surface-base">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-dim bg-surface-raised px-5 py-3">
        <h2 className="font-mono text-sm font-bold uppercase tracking-widest text-text-primary">Finish setup</h2>
        <span className="font-mono text-2xs uppercase tracking-widest text-primary-ink">
          {completedStepCount}/{FINISH_STEPS.length} complete
        </span>
      </div>
      <div className="grid gap-px bg-border-dim md:grid-cols-3">
        {FINISH_STEPS.map((step, index) => {
          const active = index === currentIndex;
          const complete = stepDone[index] === true;
          const enabled = complete || active || index === firstIncompleteIndex;
          return (
            <button
              key={step.id}
              type="button"
              onClick={() => onSelect(index)}
              disabled={!enabled}
              className={cn(
                "flex min-h-20 items-start gap-3 bg-surface-base px-4 py-4 text-left transition-colors hover:bg-surface-raised",
                active && "bg-primary-ink/10",
                !enabled && "cursor-not-allowed opacity-45 hover:bg-surface-base",
              )}
            >
              <span
                className={cn(
                  "mt-0.5 flex size-6 shrink-0 items-center justify-center border font-mono text-3xs",
                  complete
                    ? "border-primary-ink bg-primary-ink text-surface-void"
                    : active
                      ? "border-primary-ink text-primary-ink"
                      : "border-border-mid text-text-secondary",
                )}
              >
                {complete ? <CheckIcon size={12} weight="bold" /> : index + 1}
              </span>
              <span className="min-w-0">
                <span className={cn("block text-sm font-medium", active ? "text-text-primary" : "text-text-secondary")}>
                  {step.stepperLabel}
                </span>
                <span className="mt-1 block font-mono text-3xs uppercase tracking-widest text-text-secondary">
                  {step.title}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
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

// ─── Step 2: SDK implement + validate ─────────────────────────────────────────

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

type SdkDryRunTargets = RouterOutputs["onboarding"]["listSdkDryRunTargets"];
type SdkDryRunTarget = SdkDryRunTargets["targets"][number];
type TargetAvailability = SdkDryRunTarget["availability"];

/** Short state note rendered next to non-ready targets in the selectors. */
function targetAvailabilityNote(availability: TargetAvailability): string | undefined {
  if (availability === "building") return "building...";
  if (availability === "failed") return "deploy failed";
  if (availability === "no_preview") return "no preview";
  return undefined;
}

/**
 * Dry runs can only hit deployed previews, so the default pick is the first
 * READY target in preference order: auto-detected SDK PR, main, anything else.
 */
function pickInitialDryRunTargetId(targets: {
  targets: Array<{ id: string; kind: "main" | "pr"; availability: TargetAvailability }>;
  autoDetectedTargetId?: string;
}): string | undefined {
  const ready = targets.targets.filter((t) => t.availability === "ready");
  const autoDetected = ready.find((t) => t.id === targets.autoDetectedTargetId);
  return autoDetected?.id ?? ready.find((t) => t.kind === "main")?.id ?? ready[0]?.id;
}

/**
 * The initial dry-run target for a step: the URL-pinned target when it still
 * exists, otherwise the step's own default. A pinned target that has since gone
 * (PR closed, preview torn down) is no longer in the list, so it falls back
 * cleanly instead of selecting nothing.
 */
function resolveInitialTargetId(
  pinnedTargetId: string | undefined,
  targets: SdkDryRunTargets,
  fallbackTargetId: string | undefined,
): string | undefined {
  if (pinnedTargetId != null && targets.targets.some((t) => t.id === pinnedTargetId)) return pinnedTargetId;
  return fallbackTargetId;
}

/** Show the dropdown filter once the list is long enough to need one. */
const TARGET_SEARCH_THRESHOLD = 8;

interface SelectableTarget {
  id: string;
  kind: "main" | "pr";
  label: string;
  prNumber?: number;
  isAutoDetected: boolean;
  availability: TargetAvailability;
}

interface TargetSelectItemsProps {
  targets: SelectableTarget[];
}

/** Every whitespace-separated token must appear in the label or "#<pr>". */
function matchesTargetQuery(target: SelectableTarget, query: string): boolean {
  const trimmed = query.trim().toLowerCase();
  if (trimmed === "") return true;
  const haystack = `${formatTargetLabel(target)} #${target.prNumber ?? ""}`.toLowerCase();
  return trimmed.split(/\s+/).every((token) => haystack.includes(token));
}

/**
 * The dropdown body for the SDK step's target selector: a "previews are per-PR"
 * hint on top (the most common confusion is a pushed branch with no PR), a
 * title/#number filter once the PR list gets long, then every target with its
 * state spelled out. Unready targets stay selectable - the SDK step is where you
 * debug a building/failed preview, so you must be able to pick one.
 */
function TargetSelectItems({ targets }: TargetSelectItemsProps) {
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
function VercelSdkValidationSection({ applicationId }: { applicationId: string }) {
  const { data: state } = useOnboardingState(applicationId);
  const { data: deployments, isLoading } = useVercelDeployments(applicationId);
  const discover = useDiscoverVercelDeploymentTarget();
  const [selectedDeploymentId, setSelectedDeploymentId] = useState<string | undefined>(undefined);
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

  useEffect(() => {
    if (retryDeploymentId == null || !isReady || discover.isPending) return;
    const readyDeploymentId = retryDeploymentId;
    setRetryDeploymentId(undefined);
    discoverMutate(
      { applicationId, vercelDeploymentId: readyDeploymentId, allowRedeploy: false },
      { onSuccess: () => toastManager.add({ type: "success", title: "SDK endpoint reachable - schema discovered" }) },
    );
  }, [retryDeploymentId, isReady, discover.isPending, discoverMutate, applicationId]);

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
          <p className="text-sm text-text-secondary">
            No ready deployments found yet for this project. Deploy your SDK branch on Vercel and it will appear here.
          </p>
        ) : (
          <Select
            value={selectedDeploymentId ?? ""}
            onValueChange={(value) => setSelectedDeploymentId(value != null && value.length > 0 ? value : undefined)}
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

      {showDiscoveryError && (
        <div className="flex items-start gap-2 border border-status-critical/30 bg-status-critical/5 px-3 py-2">
          <WarningCircleIcon size={14} weight="fill" className="mt-0.5 shrink-0 text-status-critical" />
          <p className="font-mono text-2xs text-status-critical">{state.lastDiscoveryError}</p>
        </div>
      )}
    </div>
  );
}

/**
 * The SDK step splits by preview provider. A Vercel-linked app validates against
 * a Vercel deployment picked from the same list the onboarding flow uses - the
 * shared secret is already injected into the project, so there is no secret to
 * paste and no PR/main target to choose. Everything else keeps the manual BYO
 * flow (paste the shared secret, pick a PR/main preview target).
 */
interface SdkStepProps {
  applicationId: string;
  selectedTargetId: string | undefined;
  onSelectTarget: (id: string | undefined) => void;
}

function SdkStepBody({ applicationId, selectedTargetId, onSelectTarget }: SdkStepProps) {
  const vercelProjects = useAvailableVercelProjects(applicationId);

  if (vercelProjects.isLoading) return <Skeleton className="h-40 w-full" />;
  if (vercelProjects.data?.linkedProject != null) {
    return <VercelSdkValidationSection applicationId={applicationId} />;
  }
  return (
    <ExternalSdkStepBody
      applicationId={applicationId}
      selectedTargetId={selectedTargetId}
      onSelectTarget={onSelectTarget}
    />
  );
}

function ExternalSdkStepBody({ applicationId, selectedTargetId, onSelectTarget }: SdkStepProps) {
  const app = useCurrentApplication();
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
            <Link to="/app/$appSlug/preview-config" params={{ appSlug: app.slug }} target="_blank">
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
            <Link to="/app/$appSlug/preview-config" params={{ appSlug: app.slug }} target="_blank">
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
        title="Debug with a coding agent"
        description="Install the Autonoma MCP in your coding agent. It picks up the repo and pull request from your local git and connects automatically - no pairing code to paste."
        serverName="autonoma"
        endpoint="debug"
        docsUrl={DEBUG_MCP_DOCS_URL}
        tellAgent={
          <>
            Then, from your repo, ask your agent about the preview - e.g.{" "}
            <span className="font-mono text-text-primary">why did my preview fail?</span> or{" "}
            <span className="font-mono text-text-primary">fix my preview deploy</span>. It reads the repo and PR from
            your local git.
          </>
        }
      />

      {showDiscoveryError && (
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
              <Button variant="accent" size="sm" className="gap-2" onClick={() => setAgentDialogOpen(true)}>
                <RobotIcon size={14} weight="bold" />
                Debug with coding agent
              </Button>
              <Link to="/app/$appSlug/preview-config" params={{ appSlug: app.slug }} target="_blank">
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
                <a href={selectedTarget.previewUrl} target="_blank" rel="noopener noreferrer">
                  <Button variant="outline" size="sm" className="gap-2">
                    <ArrowSquareOutIcon size={14} weight="bold" />
                    Open preview
                  </Button>
                </a>
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

// ─── Step 3: Dry run scenarios ────────────────────────────────────────────────

function DryRunStepBody({
  applicationId,
  selectedTargetId,
}: {
  applicationId: string;
  selectedTargetId: string | undefined;
}) {
  return <DryRunList applicationId={applicationId} selectedTargetId={selectedTargetId} />;
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

function DryRunList({
  applicationId,
  selectedTargetId,
}: {
  applicationId: string;
  selectedTargetId: string | undefined;
}) {
  const { data: scenarios } = useOnboardingScenarios(applicationId);
  const { data: targets } = useSdkDryRunTargets(applicationId);
  const runDryRun = useRunScenarioDryRun();
  const [results, setResults] = useState<Record<string, DryRunResult>>({});
  const [isRunning, setIsRunning] = useState(false);
  const [logsExpanded, setLogsExpanded] = useState(true);

  // The target is owned by FinishSetupSteps and shared with the SDK step, so the
  // dry run hits exactly the preview validated there.
  const list = scenarios ?? [];
  const selectedTarget = targets.targets.find((t) => t.id === selectedTargetId);
  const selectedTargetNote = selectedTarget != null ? targetAvailabilityNote(selectedTarget.availability) : undefined;
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
      {selectedTarget != null && (
        <div className="flex flex-col gap-1.5">
          <Label>Running against</Label>
          <div className="flex items-center gap-2 text-sm text-text-primary">
            <span className="font-medium">{formatTargetLabel(selectedTarget)}</span>
            {selectedTargetNote != null && <span className="text-text-secondary">- {selectedTargetNote}</span>}
          </div>
          {selectedTarget.sdkUrl != null && (
            <p className="font-mono text-2xs text-text-secondary">SDK endpoint: {selectedTarget.sdkUrl}</p>
          )}
          <p className="text-2xs text-text-secondary">
            The target you validated on the SDK step. Go Back to run against a different preview.
          </p>
        </div>
      )}
      {selectedTarget == null && (
        <p className="text-sm text-text-secondary">
          No ready preview to run against. Go Back to the SDK step to deploy or select one.
        </p>
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
          disabled={isRunning || selectedTarget?.availability !== "ready"}
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

// ─── Step 1: CLI artifacts (command always shown) ─────────────────────────────

const ARTIFACT_DETAILS: Record<string, { label: string; description: string }> = {
  recipe: {
    label: "recipe.json",
    description: "Environment-factory recipes - how to seed and tear down test data for each scenario.",
  },
  tests: { label: "qa-tests/", description: "The generated end-to-end test cases, as markdown." },
  kb: { label: "AUTONOMA.md", description: "A knowledge base of your app's pages and flows." },
  scenarios: { label: "scenarios.md", description: "Named test-data scenarios derived from the knowledge base." },
};

interface ArtifactStatus {
  complete: boolean;
  stepComplete: boolean;
  artifacts: Array<{ key: string; received: boolean }>;
}

function ArtifactsStepBody({ applicationId, artifacts }: { applicationId: string; artifacts: ArtifactStatus }) {
  const { user, isAdmin } = useAuth();
  const { data: sharedSecretData } = useApplicationSharedSecret(applicationId);
  const setup = useCliSetup(applicationId);

  const sharedSecret = sharedSecretData?.sharedSecret;
  // AUTONOMA_API_TOKEN authenticates the CLI against our managed LLM proxy, so it
  // is now required for the planner to run (not just to upload artifacts). Only
  // surface a runnable command once that token has been provisioned.
  const envPairs =
    setup.status === "ready"
      ? [
          sharedSecret != null ? `AUTONOMA_SHARED_SECRET=${sharedSecret}` : undefined,
          user != null ? `AUTONOMA_DISTINCT_ID=${user.id}` : undefined,
          `AUTONOMA_API_TOKEN=${setup.apiKey}`,
          `AUTONOMA_GENERATION_ID=${setup.setupId}`,
        ].filter((pair): pair is string => pair != null)
      : undefined;

  const npxCommand = envPairs != null ? `${envPairs.join(" ")} npx @autonoma-ai/planner@latest` : undefined;
  const uploadCommand = envPairs != null ? `${envPairs.join(" ")} npx @autonoma-ai/planner@latest upload` : undefined;

  const missingArtifacts = artifacts.artifacts
    .filter((a) => !a.received)
    .map((a) => ARTIFACT_DETAILS[a.key]?.label ?? a.key);
  // The CLI run finished but not everything landed (typically the recipe) - surface
  // it and how to recover, rather than leaving the step silently un-completeable.
  const showIncompleteUploadHint = artifacts.complete && !artifacts.stepComplete;

  // A "Docker (sandbox)" tab used to sit alongside npx here, running the planner
  // in a throwaway `node:22` container. It was removed because the containerized
  // CLI can't fully work - no editor is available and it has no way to reach the
  // host to make requests. Restore the tab (and the docker run command) once the
  // CLI supports running inside a container. Removed in
  // https://github.com/Autonoma-AI/agent/pull/1550
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <CommandBlock command={npxCommand} />
        <p className="text-2xs leading-relaxed text-text-secondary">
          Runs the planner in your repo with Node. It analyzes the code and writes the generated files to{" "}
          <Code>~/.autonoma/&lt;your-app&gt;/</Code> before uploading them - nothing is committed to your repo.
        </p>
      </div>

      {setup.status === "loading" && (
        <p className="font-mono text-3xs text-text-secondary">
          Preparing your access token so the CLI can run on your Autonoma credits...
        </p>
      )}
      {setup.status === "error" && (
        <p className="font-mono text-3xs text-status-critical">
          Couldn't prepare your access token - the planner needs it to run. Refresh to try again.
        </p>
      )}

      <div className="flex flex-col gap-2">
        <p className="font-mono text-3xs uppercase tracking-widest text-text-secondary">What it generates + uploads</p>
        {Object.entries(ARTIFACT_DETAILS).map(([key, detail]) => {
          const received = artifacts.artifacts.find((a) => a.key === key)?.received === true;
          return (
            <div key={key} className="flex items-start gap-2.5">
              {received ? (
                <CheckCircleIcon size={14} weight="fill" className="mt-0.5 shrink-0 text-status-success" />
              ) : (
                <span className="mt-0.5 size-3.5 shrink-0 rounded-full border border-border-dim" />
              )}
              <div className="flex min-w-0 flex-col">
                <span className={cn("font-mono text-2xs", received ? "text-text-primary" : "text-text-secondary")}>
                  {detail.label}
                </span>
                <span className="text-2xs text-text-secondary">{detail.description}</span>
              </div>
            </div>
          );
        })}
        <p className="mt-1 text-2xs text-text-secondary">
          <DocLink href="https://docs.autonoma.app/test-planner/">
            Learn more about the planner and what it generates
          </DocLink>
        </p>
      </div>

      {showIncompleteUploadHint && (
        <div className="flex flex-col gap-2 border border-status-warn/30 bg-status-warn/5 px-4 py-3">
          <div className="flex items-start gap-2">
            <WarningCircleIcon size={16} weight="fill" className="mt-0.5 shrink-0 text-status-warn" />
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium text-text-primary">
                The CLI finished, but some artifacts didn't upload
              </p>
              <p className="text-2xs text-text-secondary">
                Missing: {missingArtifacts.join(", ")}. The recipe usually fails when the planner can't validate an
                environment-factory (e.g. a model with no registered factory) or the upload was rejected - and without
                it dry-run has no scenarios to provision. Re-run the planner, or re-upload the already-generated
                artifacts (idempotent - safe to run again):
              </p>
            </div>
          </div>
          <CommandBlock command={uploadCommand} />
        </div>
      )}

      {isAdmin && <AdminManualUpload applicationId={applicationId} setupId={setup.setupId} />}
    </div>
  );
}

function CommandBlock({ command }: { command?: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    if (command == null) return;
    void navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      toastManager.add({ type: "success", title: "Command copied" });
    });
  }

  return (
    <div className="relative border border-border-dim bg-surface-raised p-3 pr-12">
      <code className="block whitespace-pre-wrap break-all font-mono text-2xs leading-relaxed text-text-secondary">
        {command ?? "Preparing your CLI command..."}
      </code>
      {command != null && (
        <Button
          variant="ghost"
          size="icon-xs"
          className="absolute right-2 top-2 text-text-secondary hover:text-primary-ink"
          title={copied ? "Copied" : "Copy command"}
          onClick={handleCopy}
        >
          <CopyIcon size={14} />
        </Button>
      )}
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
  const { setup: pinnedSetupId } = Route.useSearch();
  const navigate = Route.useNavigate();

  useEffect(() => {
    // Kick off once when idle; the mutation's own lifecycle is the dedupe guard.
    // Pass the URL's setup id so the server reuses that setup instead of minting a
    // new one (stable AUTONOMA_GENERATION_ID across refreshes).
    if (isIdle) mutate({ applicationId, pinnedSetupId });
  }, [applicationId, isIdle, mutate, pinnedSetupId]);

  // Reflect the resolved setup id back into the URL so a refresh reuses it.
  const resolvedSetupId = data?.setupId;
  useEffect(() => {
    if (resolvedSetupId == null || resolvedSetupId === pinnedSetupId) return;
    void navigate({ search: (prev) => ({ ...prev, setup: resolvedSetupId }), replace: true });
  }, [resolvedSetupId, pinnedSetupId, navigate]);

  if (isError) return { status: "error" };
  if (data != null) return { status: "ready", apiKey: data.apiKey, setupId: data.setupId };
  return { status: "loading" };
}
