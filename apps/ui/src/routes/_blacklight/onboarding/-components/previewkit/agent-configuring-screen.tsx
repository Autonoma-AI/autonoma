import {
  Badge,
  Button,
  Input,
  Progress,
  ScrollArea,
  Separator,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@autonoma/blacklight";
import { type AgentLogEntry } from "@autonoma/types";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CaretUpIcon } from "@phosphor-icons/react/CaretUp";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { CircleIcon } from "@phosphor-icons/react/Circle";
import { GlobeIcon } from "@phosphor-icons/react/Globe";
import { InfoIcon } from "@phosphor-icons/react/Info";
import { PlugsConnectedIcon } from "@phosphor-icons/react/PlugsConnected";
import { SpinnerGapIcon } from "@phosphor-icons/react/SpinnerGap";
import { StopIcon } from "@phosphor-icons/react/Stop";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { XCircleIcon } from "@phosphor-icons/react/XCircle";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { PreviewLogsTabs, type PreviewLogSource } from "components/build-logs/preview-logs-tabs";
import {
  useAgentSession,
  useCompletePreviewOnboarding,
  usePreviewReadiness,
  useStopAgent,
  useSubmitAgentEnv,
} from "lib/onboarding/onboarding-api";
import { useApplications } from "lib/query/applications.queries";
import { toastManager } from "lib/toast-manager";
import { Suspense, useState, type ReactNode } from "react";
import { setLastApp } from "../../../_app-shell/-last-app";
import { PasteEnvDialog } from "../../../_app-shell/app.$appSlug/preview-config/-variables/paste-env-dialog";
import { DeployRequestIdleIndicator, isPreviewDeployRequestPhase } from "../deploy-request-indicator";
import { PreviewTakingShape } from "./preview-taking-shape";

// Deploy phases in which the app pods are rolling out (and emitting runtime logs),
// as opposed to the earlier clone/build phases. Used to auto-focus the App logs tab.
const APP_ROLLOUT_PHASES = new Set(["deploying-services"]);

/**
 * The read-only "Claude is configuring your preview" screen shown while a coding
 * agent holds the config (over the onboarding MCP). Polls the session, streams the
 * agent's tool calls, surfaces any question the agent raised (env values), and
 * lets the user take over. The parent decides when to render this (agent holds);
 * once the user takes over, the parent swaps back to the editable form.
 */
export function AgentConfiguringScreen({ applicationId }: { applicationId: string }) {
  const { data: session } = useAgentSession(applicationId);
  const { data: applications } = useApplications();
  const stopAgent = useStopAgent();
  const complete = useCompletePreviewOnboarding();
  const navigate = useNavigate();
  const router = useRouter();
  // Once the preview is live the verbose activity (tool calls, the config cards,
  // the deploy logs) has served its purpose, so collapse it to a compact "you're
  // live, continue" card - but keep it one click away for anyone who wants to look.
  const [detailsExpanded, setDetailsExpanded] = useState(false);

  if (session == null) return undefined;

  const logs = session.logs;
  const doneCount = logs.filter((entry) => entry.status === "done").length;
  const total = logs.length;
  const running = [...logs].reverse().find((entry) => entry.status === "running");
  const ready = session.previewVerificationStatus === "ready";
  const pendingEnv = session.pendingRequest?.kind === "env" ? session.pendingRequest : undefined;
  // While the agent works, everything is on show; once ready, details collapse
  // behind the toggle (the deploy status/url/services stay - only the noisy
  // sections and logs fold away).
  const showDetails = !ready || detailsExpanded;

  // A ready agent-driven preview is the end of preview onboarding, but nothing
  // advances the flow on its own - the agent holds the config and the user is
  // read-only. Mirror the manual deploy-verify screen: hand the user the forward
  // action (complete onboarding -> land on the app) once the preview is live.
  function continueOnboarding() {
    const application = applications.find((app) => app.id === applicationId);
    if (application == null) {
      toastManager.add({ type: "critical", title: "Application not found" });
      return;
    }
    complete.mutate(
      { applicationId },
      {
        onSuccess: async () => {
          setLastApp(application.slug);
          await router.invalidate();
          void navigate({ to: "/app/$appSlug", params: { appSlug: application.slug }, replace: true });
        },
      },
    );
  }

  return (
    <div className="flex flex-col gap-4 border border-border-dim bg-surface-base p-6">
      <div className="flex items-center justify-between">
        <Badge variant="success" className="gap-1.5 font-mono">
          <PlugsConnectedIcon weight="bold" />
          MCP · onboarding · connected
        </Badge>
        <Button
          variant="outline"
          size="sm"
          onClick={() => stopAgent.mutate({ applicationId })}
          disabled={stopAgent.isPending}
        >
          <StopIcon weight="bold" />
          Take over
        </Button>
      </div>

      <div className="flex items-center gap-3">
        {ready ? (
          <CheckCircleIcon weight="fill" className="size-6 text-status-success" />
        ) : (
          <SpinnerGapIcon weight="bold" className="size-6 animate-spin text-primary" />
        )}
        <div className="flex flex-col">
          <span className="font-sans text-lg text-text-primary">
            {ready ? "Your preview is live" : `${agentDisplayName(session.agentClient)} is configuring your preview`}
          </span>
          <span className="font-mono text-2xs text-text-secondary">
            {ready ? "You can continue onboarding" : (running?.message ?? "Working…")}
          </span>
        </div>
        <span className="ml-auto font-mono text-2xs text-text-secondary">
          {doneCount} / {total} calls
        </span>
      </div>

      <Progress value={total === 0 ? 0 : (doneCount / total) * 100} />

      {pendingEnv != null && (
        <EnvRequestForm
          // Remount per distinct request so values/skips from an answered request
          // never leak into the next one.
          key={`${pendingEnv.appName}:${pendingEnv.keys.join(",")}`}
          applicationId={applicationId}
          appName={pendingEnv.appName}
          keys={pendingEnv.keys}
          note={pendingEnv.note}
          agentName={agentDisplayName(session.agentClient)}
        />
      )}

      {ready ? (
        <div className="flex justify-center">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-text-secondary"
            onClick={() => setDetailsExpanded((value) => !value)}
          >
            {detailsExpanded ? <CaretUpIcon weight="bold" /> : <CaretDownIcon weight="bold" />}
            {detailsExpanded ? "Hide configuration & logs" : "Show configuration & logs"}
          </Button>
        </div>
      ) : undefined}

      {showDetails ? (
        <>
          <Separator />

          <div className="grid gap-4 md:grid-cols-2">
            <div className="flex flex-col gap-2">
              <SectionTitle>Tool calls</SectionTitle>
              <ScrollArea className="max-h-96">
                <div className="flex flex-col gap-1.5">
                  {logs.length === 0 ? (
                    <p className="font-mono text-2xs text-text-secondary">Waiting for the agent to start…</p>
                  ) : (
                    logs.map((entry) => <ToolCallRow key={entry.id} entry={entry} />)
                  )}
                </div>
              </ScrollArea>
            </div>

            <Suspense fallback={<Skeleton className="h-48 w-full" />}>
              <PreviewTakingShape applicationId={applicationId} />
            </Suspense>
          </div>
        </>
      ) : undefined}

      <Separator />

      <Suspense fallback={<Skeleton className="h-48 w-full" />}>
        <DeploySection applicationId={applicationId} showLogs={showDetails} />
      </Suspense>

      {ready ? (
        <>
          <Separator />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="font-mono text-2xs text-text-secondary">
              Preview verified. Continue to start generating tests against it - or Take over to tweak the config first.
            </p>
            <Button variant="accent" className="gap-2" onClick={continueOnboarding} disabled={complete.isPending}>
              {complete.isPending ? "Continuing…" : "Continue"}
              <ArrowRightIcon weight="bold" />
            </Button>
          </div>
        </>
      ) : undefined}
    </div>
  );
}

/** Section heading used inside the read-only configuring screen. */
function SectionTitle({ children }: { children: ReactNode }) {
  return <p className="font-mono text-2xs uppercase tracking-widest text-text-secondary">{children}</p>;
}

/**
 * The live deploy status and logs, shown read-only below the activity stream (no
 * redeploy/edit actions - the agent drives). Surfaces the same build/app log tabs
 * the deploy-verify screen uses, so the user can watch the deploy and see failures
 * as they happen instead of a bare spinner.
 */
function DeploySection({ applicationId, showLogs }: { applicationId: string; showLogs: boolean }) {
  const { data } = usePreviewReadiness(applicationId);
  const { diagnostics, previewUrl, services } = data;
  const isReady = diagnostics.status === "ready";
  const isFailed = diagnostics.status === "failed";
  // The app pods roll out (and start emitting runtime logs) once the deploy reaches
  // the service-rollout phase - before that we are still cloning/building the image.
  const appRollingOut = diagnostics.phase != null && APP_ROLLOUT_PHASES.has(diagnostics.phase);
  const imageBuilding = (diagnostics.status === "building" || diagnostics.status === "idle") && !appRollingOut;
  // Follow the deploy: watch the build while the image builds, then auto-switch to app
  // logs the moment the app starts rolling out, so the user sees runtime output without
  // switching tabs themselves. A "failed" deploy keeps the build tab (the terminal
  // failure marker is on the build stream; the app stream is empty on a build/platform
  // failure). An explicit tab pick always wins.
  const [logSourceOverride, setLogSourceOverride] = useState<PreviewLogSource | undefined>(undefined);
  const logSource: PreviewLogSource = logSourceOverride ?? (isReady || appRollingOut ? "app" : "build");

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <SectionTitle>Deploy</SectionTitle>
        <DeployStatusBadge status={diagnostics.status} />
      </div>

      {previewUrl != null ? (
        <a
          href={previewUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex max-w-full items-center gap-1.5 truncate font-mono text-2xs text-primary hover:underline"
        >
          <GlobeIcon size={13} />
          {previewUrl}
        </a>
      ) : isPreviewDeployRequestPhase(diagnostics.phase) ? (
        // The request-accepted window: the deploy was dispatched but no worker
        // activity exists yet, so logs are empty for up to a minute. Show the
        // queued stepper (same as the manual deploy-verify page) instead of
        // leaving the user staring at "Logs appear once a deploy starts."
        <DeployRequestIdleIndicator />
      ) : undefined}

      {diagnostics.error != null ? (
        isFailed ? (
          <div className="flex items-start gap-2 border-l-2 border-status-critical bg-status-critical/10 px-3 py-2">
            <WarningCircleIcon size={14} className="mt-0.5 shrink-0 text-status-critical" />
            <p className="font-mono text-2xs text-text-secondary">{diagnostics.error}</p>
          </div>
        ) : (
          // A "not deployed yet" / still-building note is informational, not an
          // error - keep it neutral. Red is reserved for an actual failure.
          <p className="font-mono text-2xs text-text-secondary">{diagnostics.error}</p>
        )
      ) : undefined}

      {services.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {services.map((service) => (
            <Tooltip key={service.name}>
              <TooltipTrigger
                render={
                  <Badge variant="outline" className="cursor-help gap-1.5 font-mono">
                    {service.name}
                    <span className="text-text-secondary">{service.status}</span>
                    <InfoIcon size={11} className="text-text-secondary" />
                  </Badge>
                }
              />
              <TooltipContent className="max-w-xs">{serviceStatusHint(service.status)}</TooltipContent>
            </Tooltip>
          ))}
        </div>
      ) : undefined}

      {showLogs ? (
        diagnostics.logs.available ? (
          <PreviewLogsTabs
            owner={repoOwner(diagnostics.logs.repoFullName)}
            repo={repoName(diagnostics.logs.repoFullName)}
            pr={diagnostics.logs.prNumber}
            appBuilding={imageBuilding}
            source={logSource}
            onSourceChange={setLogSourceOverride}
          />
        ) : (
          <p className="font-mono text-2xs text-text-secondary">Logs appear once a deploy starts.</p>
        )
      ) : undefined}
    </div>
  );
}

/** Human explanation of a preview service's status, shown on hover - the raw word alone (e.g. "unknown") is opaque. */
function serviceStatusHint(status: "ready" | "building" | "failed" | "unknown"): string {
  if (status === "ready") return "This service is up and accepting connections.";
  if (status === "building") return "This service is still starting up.";
  if (status === "failed") return "This service failed to start.";
  return "Autonoma hasn't reported this service's status yet - it may still be starting.";
}

function DeployStatusBadge({ status }: { status: "idle" | "building" | "ready" | "failed" }) {
  if (status === "ready") return <Badge variant="success">ready</Badge>;
  if (status === "failed") return <Badge variant="critical">failed</Badge>;
  if (status === "building") return <Badge variant="status-running">building</Badge>;
  return <Badge variant="secondary">idle</Badge>;
}

function repoOwner(repoFullName: string): string {
  return repoFullName.split("/")[0] ?? repoFullName;
}

function repoName(repoFullName: string): string {
  return repoFullName.split("/")[1] ?? repoFullName;
}

/**
 * A friendly name for the driving coding agent from its MCP `clientInfo`. The
 * client-reported name varies ("claude-code", "cursor", "Windsurf", ...), so we
 * match the ones we know and fall back to a neutral label - never assume Claude.
 */
function agentDisplayName(client?: string): string {
  if (client == null) return "Your coding agent";
  const normalized = client.toLowerCase();
  if (normalized.includes("claude")) return "Claude";
  if (normalized.includes("cursor")) return "Cursor";
  if (normalized.includes("codex") || normalized.includes("openai")) return "Codex";
  if (normalized.includes("windsurf")) return "Windsurf";
  if (normalized.includes("cline")) return "Cline";
  if (normalized.includes("copilot")) return "Copilot";
  return "Your coding agent";
}

function ToolCallRow({ entry }: { entry: AgentLogEntry }) {
  // Lead with the agent's human-readable summary; the raw tool name rides along as
  // a dim mono tag for the curious. Fall back to the tool name + args only when no
  // summary was given (older entries / tools without one).
  const summary = entry.message ?? entry.tool;
  const showToolTag = entry.message != null && entry.tool != null;
  return (
    <div className="flex items-start gap-2 text-2xs">
      <StatusGlyph status={entry.status} />
      <span className="text-text-primary">{summary}</span>
      {showToolTag ? (
        <span className="font-mono text-text-secondary">{entry.tool}</span>
      ) : entry.toolArguments != null ? (
        <span className="truncate font-mono text-text-secondary">{JSON.stringify(entry.toolArguments)}</span>
      ) : undefined}
      {entry.status === "error" && entry.error != null && <span className="text-status-critical">{entry.error}</span>}
    </div>
  );
}

function StatusGlyph({ status }: { status?: AgentLogEntry["status"] }) {
  if (status === "done") return <CheckCircleIcon weight="fill" className="size-3.5 shrink-0 text-status-success" />;
  if (status === "error") return <XCircleIcon weight="fill" className="size-3.5 shrink-0 text-status-critical" />;
  if (status === "running")
    return <SpinnerGapIcon weight="bold" className="size-3.5 shrink-0 animate-spin text-primary" />;
  return <CircleIcon className="size-3.5 shrink-0 text-text-secondary" />;
}

/**
 * The inline env-value form the agent's request surfaces: one row per requested
 * key (value input + a skip toggle for keys the user doesn't have), plus the
 * shared paste-.env dialog to fill matching rows at once. Values never reach the
 * agent - they go straight to the backend; skipped keys are fed back so the
 * agent adapts instead of waiting on a value that doesn't exist.
 */
function EnvRequestForm({
  applicationId,
  appName,
  keys,
  note,
  agentName,
}: {
  applicationId: string;
  appName: string;
  keys: string[];
  note?: string;
  agentName: string;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const submitEnv = useSubmitAgentEnv();

  function setValue(key: string, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  // Fill only the keys the agent actually asked for - never persist unrelated
  // secrets the user happens to have in their .env.
  function importDotenv(entries: Array<{ key: string; value: string }>) {
    const requested = new Set(keys);
    const matched = entries.filter((entry) => requested.has(entry.key));
    setValues((current) => {
      const next = { ...current };
      for (const entry of matched) next[entry.key] = entry.value;
      return next;
    });
  }

  // A key left empty means "I don't have this": submitting reports it as
  // skipped so the agent adapts (default, drop, rework) instead of waiting on
  // a value that doesn't exist. No per-key toggle - the filled/empty state IS
  // the answer, and the button label spells out what will happen.
  const items = keys
    .filter((key) => (values[key] ?? "").trim() !== "")
    .map((key) => ({ key, value: values[key] ?? "" }));
  const skippedKeys = keys.filter((key) => (values[key] ?? "").trim() === "");

  function submit() {
    submitEnv.mutate({ applicationId, appName, items, skippedKeys });
  }

  return (
    <div className="flex flex-col gap-3 border border-primary/40 bg-surface-raised p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-2xs text-text-primary">
          {agentName} needs these environment values for <span className="font-mono">{appName}</span>. Values stay in
          your browser and go straight to Autonoma - the agent never sees them.
        </p>
        <div className="ml-auto">
          <PasteEnvDialog
            description={
              <>
                Paste your <span className="font-mono">.env</span> to fill the requested keys at once. Only the keys the
                agent asked for are used - everything else is ignored. Values go straight to Autonoma; the agent never
                sees them.
              </>
            }
            onImport={importDotenv}
          />
        </div>
      </div>
      {note != null && <p className="text-2xs text-text-secondary">{note}</p>}
      <div className="flex flex-col gap-2">
        {keys.map((key) => (
          <div key={key} className="grid grid-cols-[minmax(9rem,0.6fr)_minmax(10rem,1fr)] items-center gap-2">
            <span className="truncate font-mono text-2xs">{key}</span>
            <Input
              aria-label={`Value for ${key}`}
              type="password"
              value={values[key] ?? ""}
              onChange={(event) => setValue(key, event.target.value)}
              placeholder="Value"
              className="font-mono"
            />
          </div>
        ))}
      </div>
      {submitEnv.isError && (
        <p className="text-2xs text-status-critical">
          {submitEnv.error?.message ?? "Failed to set the values. Check the keys and try again."}
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        <span className="mr-auto font-mono text-3xs text-text-secondary">
          {items.length} of {keys.length} filled · empty keys are reported as unavailable so the agent adapts
        </span>
        {items.length === 0 ? (
          <Button size="sm" variant="outline" onClick={submit} disabled={submitEnv.isPending}>
            I don't have these
          </Button>
        ) : (
          <Button size="sm" onClick={submit} disabled={submitEnv.isPending}>
            {skippedKeys.length === 0 ? "Set on Autonoma" : `Set ${items.length} · skip ${skippedKeys.length}`}
          </Button>
        )}
      </div>
    </div>
  );
}
