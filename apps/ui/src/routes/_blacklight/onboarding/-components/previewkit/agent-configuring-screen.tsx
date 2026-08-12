import {
  Badge,
  BrailleSpinner,
  Button,
  Checkbox,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
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
import { BellRingingIcon } from "@phosphor-icons/react/BellRinging";
import { BellSlashIcon } from "@phosphor-icons/react/BellSlash";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CaretUpIcon } from "@phosphor-icons/react/CaretUp";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { EyeIcon } from "@phosphor-icons/react/Eye";
import { EyeSlashIcon } from "@phosphor-icons/react/EyeSlash";
import { GlobeIcon } from "@phosphor-icons/react/Globe";
import { InfoIcon } from "@phosphor-icons/react/Info";
import { PlugsConnectedIcon } from "@phosphor-icons/react/PlugsConnected";
import { StopIcon } from "@phosphor-icons/react/Stop";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { WrenchIcon } from "@phosphor-icons/react/Wrench";
import { Link, Navigate } from "@tanstack/react-router";
import { PreviewLogsTabs, type PreviewLogSource } from "components/build-logs/preview-logs-tabs";
import { PreviewLink } from "components/preview-link";
import { TabAttention } from "components/tab-attention";
import { playChime } from "lib/attention/play-chime";
import { agentDisplayName } from "lib/onboarding/agent-display-name";
import { useAgentSession, usePreviewReadiness, useStopAgent, useSubmitAgentEnv } from "lib/onboarding/onboarding-api";
import { buildOnboardingSearch } from "lib/onboarding/onboarding-search";
import { useApplications } from "lib/query/applications.queries";
import { toastManager } from "lib/toast-manager";
import { Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { PasteEnvDialog } from "../../../_app-shell/app.$appSlug/settings/previews/-variables/paste-env-dialog";
import { DeployRequestIdleIndicator, isPreviewDeployRequestPhase } from "../deploy-request-indicator";
import { IntegrationTakingShape } from "./integration-taking-shape";
import { PreviewTakingShape } from "./preview-taking-shape";

// Deploy phases in which the app pods are rolling out (and emitting runtime logs),
// as opposed to the earlier clone/build phases. Used to auto-focus the App logs tab.
const APP_ROLLOUT_PHASES = new Set(["deploying-services"]);

/**
 * How long without a tool call before we tell the user their agent looks stuck.
 * Short on purpose: an agent that is genuinely working polls far more often than
 * this, so being early costs a warning that clears itself, while being late
 * costs the user waiting on someone who is waiting on them. The server does not
 * release control until 30 minutes (STALE_AFTER_MS), which is far too long to
 * leave a spinner running with no explanation.
 */
const STALLED_AFTER_MS = 3 * 60 * 1000;

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
  // Once the preview is live the verbose activity (tool calls, the config cards,
  // the deploy logs) has served its purpose, so collapse it to a compact "you're
  // live, continue" card - but keep it one click away for anyone who wants to look.
  const [detailsExpanded, setDetailsExpanded] = useState(false);

  // Attention: the agent session can sit for minutes (building, thinking) and the
  // user tabs away; when it needs them (env request, deploy done/failed) the tab
  // title/favicon change, a chime plays, and - opted in - a browser notification
  // fires. Driven by the session poll (which keeps polling in background tabs);
  // the title/favicon themselves render declaratively via <TabAttention>.
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [browserNotificationsEnabled, setBrowserNotificationsEnabled] = useState(
    () => typeof Notification !== "undefined" && Notification.permission === "granted",
  );
  const [attentionMessage, setAttentionMessage] = useState<string | undefined>(undefined);

  const pendingRequestKind = session?.pendingRequest?.kind;
  const verificationStatus = session?.previewVerificationStatus;
  const agentClient = session?.agentClient;
  const previousRef = useRef<
    { pendingRequestKind: "env" | "choice" | undefined; verificationStatus: string } | undefined
  >(undefined);
  // Transition detection over polled data. useEffect is the right tool here: the
  // chime and notification are true side effects, fired once per transition (a
  // request appearing, the preview turning ready/failed) - never on first load.
  useEffect(() => {
    if (verificationStatus == null) return;
    const previous = previousRef.current;
    previousRef.current = { pendingRequestKind, verificationStatus };
    if (previous == null) return;

    const requestRaised = previous.pendingRequestKind == null && pendingRequestKind != null;
    const becameReady = previous.verificationStatus !== "ready" && verificationStatus === "ready";
    const becameFailed = previous.verificationStatus !== "failed" && verificationStatus === "failed";
    const message = requestRaised
      ? `${agentDisplayName(agentClient)} needs your input`
      : becameReady
        ? "Your preview is live"
        : becameFailed
          ? "Preview deploy failed"
          : undefined;
    if (message == null) return;

    setAttentionMessage(message);
    if (document.hasFocus()) return;
    if (soundEnabled) playChime();
    showBrowserNotification(browserNotificationsEnabled, message);
  }, [pendingRequestKind, verificationStatus, agentClient, soundEnabled, browserNotificationsEnabled]);

  if (session == null) return undefined;

  const logs = session.logs;
  // A tool call that errored is finished, not outstanding: the error went back to the
  // agent, which adapts and moves on. Counting only `done` left the bar permanently
  // short of the work the agent had actually got through.
  const finishedCount = logs.filter((entry) => entry.status !== "running").length;
  const total = logs.length;
  const running = [...logs].reverse().find((entry) => entry.status === "running");
  const ready = session.previewVerificationStatus === "ready";
  // The agent beats `agentLastActivityAt` on every tool call, including its own
  // status polls, so a gap this long means it is not calling anything - stuck, or
  // waiting on an answer it asked for in the chat where we cannot see it. Control
  // is not released until STALE_AFTER_MS (30 min) server-side, so without this the
  // user watches a spinner for half an hour with no idea they are the blocker.
  //
  // Applies just as much once the preview is verified. An agent that stops there
  // without going live leaves the app one step short, and this screen now waits for
  // that step rather than offering it - so silence after `ready` is the case where
  // the user most needs telling, not one to exempt. A run that has actually gone live
  // never reaches here; it redirects below.
  const stalled = isStalled(session.agentLastActivityAt);
  // The agent's own words for why it picked this path, already persisted as that
  // tool call's activity message. Promoted out of the feed because it scrolls
  // away, and it is the decision most worth catching if the agent got it wrong.
  const pathReason = logs.find((entry) => entry.tool === "select_preview_path")?.message;
  const pendingEnv = session.pendingRequest?.kind === "env" ? session.pendingRequest : undefined;
  // While the agent works, everything is on show; once ready, details collapse
  // behind the toggle (the deploy status/url/services stay - only the noisy
  // sections and logs fold away).
  const showDetails = !ready || detailsExpanded;

  // Whoever holds the config advances it, and here that is the agent: the onboarding
  // MCP's go-live tool moves the app past `preview_verified`, and the agent is told to
  // call it as soon as the preview is good. So the step moving on is the signal this
  // screen is finished - follow it, rather than asking the user to click a transition
  // that has already happened.
  //
  // While the preview is ready the step is at `preview_verified` or beyond, so leaving
  // it is the whole condition. Stay in the onboarding flow and resume: the route reads
  // the app's state and lands on whatever is genuinely next - the SDK, the upload, or
  // the finished screen if an agent already did all of it.
  const wentLive = ready && session.step !== "preview_verified";
  const application = applications.find((app) => app.id === applicationId);
  if (wentLive && application != null) {
    return <Navigate to="/onboarding" search={buildOnboardingSearch(undefined, application.id)} replace />;
  }

  return (
    <div className="flex flex-col gap-4 border border-border-dim bg-surface-base p-6">
      <TabAttention message={attentionMessage} />
      <div className="flex items-center justify-between">
        <Badge variant="success" className="gap-1.5 font-mono">
          <PlugsConnectedIcon weight="bold" />
          MCP · onboarding · connected
        </Badge>
        <div className="flex items-center gap-1.5">
          <AttentionMenu
            soundEnabled={soundEnabled}
            onSoundChange={setSoundEnabled}
            notificationsEnabled={browserNotificationsEnabled}
            onNotificationsChange={setBrowserNotificationsEnabled}
          />
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
      </div>

      <div className="flex items-center gap-3">
        {ready ? (
          <CheckCircleIcon weight="fill" className="size-6 text-status-success" />
        ) : stalled ? (
          <WarningCircleIcon weight="fill" className="size-6 text-status-warn" />
        ) : (
          <BrailleSpinner animation="braille" size="xl" className="w-6 text-center text-primary" />
        )}
        <div className="flex flex-col">
          <span className="font-sans text-lg text-text-primary">
            {ready
              ? "Your preview is live"
              : stalled
                ? `${agentDisplayName(session.agentClient)} seems stuck`
                : agentHeadline(session.agentClient, session.previewEnvironmentMode)}
          </span>
          <span className="font-mono text-2xs text-text-secondary">
            {ready ? "Your agent is carrying on from here" : (running?.message ?? "Working…")}
          </span>
        </div>
        <span className="ml-auto font-mono text-2xs text-text-secondary">
          {finishedCount} / {total} calls
        </span>
      </div>

      {stalled ? (
        <div className="flex items-start gap-3 border-l-2 border-status-warn bg-status-warn/10 px-4 py-3">
          <WarningCircleIcon size={16} weight="fill" className="mt-0.5 shrink-0 text-status-warn" />
          <div className="flex flex-col gap-1">
            <p className="text-sm text-text-primary">
              No activity for a few minutes. {agentDisplayName(session.agentClient)} may be waiting on you.
            </p>
            <p className="text-2xs leading-relaxed text-text-secondary">
              Check the terminal or chat where you started it - agents often stop to ask a question, and it cannot see
              this screen. If it is idle rather than asking, tell it to continue, or Take over and finish here yourself.
            </p>
          </div>
        </div>
      ) : undefined}

      <Progress value={total === 0 ? 0 : (finishedCount / total) * 100} />

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

            {/* Each path shows what it is assembling, in the same column: an
                Autonoma-hosted preview has a topology, the customer's own
                pipeline has an integration. Before a path is chosen there is
                neither - the config is a default nobody picked, so showing it
                would promise apps and databases we may never build. */}
            {session.previewEnvironmentMode == null ? undefined : (
              <div className="flex flex-col gap-2">
                <ChosenPath mode={session.previewEnvironmentMode} reason={pathReason} appId={applicationId} />
                {session.previewEnvironmentMode === "previewkit" ? (
                  <Suspense fallback={<Skeleton className="h-48 w-full" />}>
                    <PreviewTakingShape applicationId={applicationId} />
                  </Suspense>
                ) : (
                  <IntegrationTakingShape applicationId={applicationId} />
                )}
              </div>
            )}
          </div>
        </>
      ) : undefined}

      <Separator />

      <Suspense fallback={<Skeleton className="h-48 w-full" />}>
        <DeploySection
          applicationId={applicationId}
          showLogs={showDetails}
          agentName={agentDisplayName(session.agentClient)}
          agentStalled={stalled}
        />
      </Suspense>

      {ready ? (
        <>
          <Separator />
          {/* Never promise work that has stopped: an agent can verify the preview and
              then go quiet without taking the app live, and this screen waits for that
              step rather than offering it - so a spinner alone would sit there
              indefinitely saying something untrue. */}
          <div className="flex items-center gap-2.5">
            {stalled ? (
              <WarningCircleIcon size={14} weight="fill" className="shrink-0 text-status-warn" />
            ) : (
              <BrailleSpinner animation="braille" size="sm" className="shrink-0 text-text-secondary" />
            )}
            <p className="font-mono text-2xs text-text-secondary">
              {stalled
                ? "Preview verified, but your agent has gone quiet without taking the app live. Tell it to continue, or Take over above and finish here yourself."
                : "Preview verified. Your agent is taking the app live, then moving on to the SDK and test artifacts - this page follows it. Take over above to change the config instead."}
            </p>
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

/** Fire a browser notification when opted in, permitted, and the tab is unfocused (focused users see the UI). */
function showBrowserNotification(enabled: boolean, message: string): void {
  if (!enabled || typeof Notification === "undefined") return;
  if (Notification.permission !== "granted" || document.hasFocus()) return;
  try {
    new Notification("Autonoma", { body: message });
  } catch (err) {
    // Some platforms (e.g. Android Chrome) only allow notifications via a
    // service worker - the tab flash and chime still cover the alert.
    console.debug("Browser notification failed", err);
  }
}

/**
 * What the browser will actually do with a notification right now, in the user's
 * words. "Enabled" in our UI is not the same as "will appear": the permission can
 * be denied or never asked, and the checkbox looks identical either way - which
 * is why "notifications never work" has been so hard to pin down.
 */
function notificationPermissionLabel(): string {
  if (typeof Notification === "undefined") return "not supported in this browser";
  if (Notification.permission === "granted") return "allowed by your browser";
  if (Notification.permission === "denied") return "blocked in your browser settings";
  return "not requested yet";
}

/**
 * Sound + browser-notification opt-ins for the attention cues. The tab-title
 * flash is always on (harmless); sound defaults on and is toggleable; browser
 * notifications need an explicit permission grant, requested on first toggle.
 */
/**
 * One "Notify me" button opening the attention preferences: a sound checkbox
 * and a browser-notification checkbox (which requests the browser permission
 * on first check). A single labeled entry point instead of two bare icons -
 * the user shouldn't have to guess what a speaker and a bell mean here.
 */
function AttentionMenu({
  soundEnabled,
  onSoundChange,
  notificationsEnabled,
  onNotificationsChange,
}: {
  soundEnabled: boolean;
  onSoundChange: (enabled: boolean) => void;
  notificationsEnabled: boolean;
  onNotificationsChange: (enabled: boolean) => void;
}) {
  const notificationsSupported = typeof Notification !== "undefined";
  const anyEnabled = soundEnabled || notificationsEnabled;

  async function handleNotificationsChange(checked: boolean) {
    if (!checked) {
      onNotificationsChange(false);
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      toastManager.add({
        type: "critical",
        title: "Notifications are blocked",
        description: "Allow notifications for this site in your browser settings to get notified.",
      });
      return;
    }
    onNotificationsChange(true);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="sm" className="gap-1.5 text-text-secondary">
            {anyEnabled ? <BellRingingIcon weight="bold" /> : <BellSlashIcon weight="bold" />}
            Notify me
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="flex w-72 flex-col gap-3 p-3">
        <p className="text-2xs text-text-secondary">
          Get pinged when the agent needs your input or the deploy finishes - useful when you tab away. The tab title
          always changes.
        </p>
        <label className="flex items-center gap-2 text-2xs text-text-primary">
          <Checkbox checked={soundEnabled} onCheckedChange={(checked) => onSoundChange(checked === true)} />
          Play a sound
        </label>
        {notificationsSupported ? (
          <label className="flex items-start gap-2 text-2xs text-text-primary">
            <Checkbox
              checked={notificationsEnabled}
              onCheckedChange={(checked) => void handleNotificationsChange(checked === true)}
            />
            <span className="flex flex-col">
              Show a browser notification
              <span className="text-3xs text-text-secondary">Currently {notificationPermissionLabel()}</span>
            </span>
          </label>
        ) : undefined}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The live deploy status and logs, shown read-only below the activity stream (no
 * redeploy/edit actions - the agent drives). Surfaces the same build/app log tabs
 * the deploy-verify screen uses, so the user can watch the deploy and see failures
 * as they happen instead of a bare spinner.
 */
function DeploySection({
  applicationId,
  showLogs,
  agentName,
  agentStalled,
}: {
  applicationId: string;
  showLogs: boolean;
  /** Whose iteration this is, for the wording when a deploy fails while they work. */
  agentName: string;
  /** True when the agent's heartbeat has gone quiet - nobody is acting on a failure. */
  agentStalled: boolean;
}) {
  const { data } = usePreviewReadiness(applicationId);
  const { diagnostics, previewUrl, services } = data;
  // Must stay above the mode early returns below. `usePreviewReadiness` polls, and
  // `mode` is absent until a preview path is picked - when an agent picks one the
  // poll flips it under a mounted fiber, so a hook declared after those returns
  // changes the hook count mid-render and throws React #310.
  const [logSourceOverride, setLogSourceOverride] = useState<PreviewLogSource | undefined>(undefined);
  // Same constraint on both: declared before the mode early returns, never after.
  const attemptKey = useDeployAttemptKey(diagnostics.status);
  const [logsExpanded, setLogsExpanded] = useState(false);

  // Before a path is picked the agent is still reading the repo, and there is
  // nothing to deploy either way - a Deploy panel here would show an idle status
  // for a deploy that may never be ours to run.
  if (data.mode == null) {
    return (
      <div className="flex flex-col gap-2">
        <SectionTitle>Preview</SectionTitle>
        <p className="font-mono text-2xs text-text-secondary">
          Working out how this app should get its previews - whether Autonoma builds them, or your own pipeline does.
        </p>
      </div>
    );
  }

  // The customer's pipeline builds these previews, so there is no build to watch
  // and no build/app log stream on our side - but the signal landing is still the
  // live state, and it belongs in the same slot the deploy status occupies for an
  // Autonoma-hosted preview.
  if (data.mode === "existing_deploys") {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <SectionTitle>Preview signal</SectionTitle>
          <DeployStatusBadge status={diagnostics.status} retrying={false} />
        </div>
        {previewUrl != null ? (
          <PreviewLink
            url={previewUrl}
            className="inline-flex max-w-full items-center gap-1.5 truncate font-mono text-2xs text-primary hover:underline"
          >
            <GlobeIcon size={13} />
            {previewUrl}
          </PreviewLink>
        ) : (
          <p className="font-mono text-2xs text-text-secondary">
            Waiting for your pipeline to signal that a preview is live. Your agent wires that up and confirms it lands.
          </p>
        )}
      </div>
    );
  }

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
  const logSource: PreviewLogSource = logSourceOverride ?? (isReady || appRollingOut ? "app" : "build");
  // Whether a deploy is producing output right now, which is the only time an open log
  // panel is telling the truth. `building` covers the whole pipeline; the request window
  // is the minute between dispatch and the worker picking it up, where the status is
  // still idle but a deploy is genuinely on its way.
  const deployRunning = diagnostics.status === "building" || isPreviewDeployRequestPhase(diagnostics.phase);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <SectionTitle>Deploy</SectionTitle>
        <DeployStatusBadge status={diagnostics.status} retrying={!agentStalled} />
        {/* One status, one phase, one place - the log card below reports neither, so
            these cannot come to disagree with it. */}
        {diagnostics.phase != null ? (
          <span className="font-mono text-2xs text-text-secondary">{diagnostics.phase.replaceAll("_", " ")}</span>
        ) : undefined}
      </div>

      {previewUrl != null ? (
        <PreviewLink
          url={previewUrl}
          className="inline-flex max-w-full items-center gap-1.5 truncate font-mono text-2xs text-primary hover:underline"
        >
          <GlobeIcon size={13} />
          {previewUrl}
        </PreviewLink>
      ) : isPreviewDeployRequestPhase(diagnostics.phase) ? (
        // The request-accepted window: the deploy was dispatched but no worker
        // activity exists yet, so logs are empty for up to a minute. Show the
        // queued stepper (same as the manual deploy-verify page) instead of
        // leaving the user staring at "Logs appear once a deploy starts."
        <DeployRequestIdleIndicator />
      ) : undefined}

      {diagnostics.error != null ? (
        isFailed ? (
          <FailedDeployNote error={diagnostics.error} agentName={agentName} agentStalled={agentStalled} />
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
                    <span className="text-text-secondary">{serviceStatusLabel(service)}</span>
                    <InfoIcon size={11} className="text-text-secondary" />
                  </Badge>
                }
              />
              <TooltipContent className="max-w-xs">{serviceStatusHint(service)}</TooltipContent>
            </Tooltip>
          ))}
        </div>
      ) : undefined}

      {showLogs ? (
        diagnostics.logs.available ? (
          <>
            {/* Off a running deploy the terminal is an invitation to misread: the agent
                spends most of a session reading the repo and editing config, none of
                which produces a line, so an open panel showing the last deploy's output
                reads as what is happening right now. Deploying, it opens itself. */}
            {!deployRunning ? (
              <Button
                variant="ghost"
                size="sm"
                className="w-fit gap-1.5 px-0 text-text-secondary"
                onClick={() => setLogsExpanded((value) => !value)}
              >
                {logsExpanded ? <CaretUpIcon weight="bold" /> : <CaretDownIcon weight="bold" />}
                {logsExpanded ? "Hide logs" : "View logs from the last deploy"}
              </Button>
            ) : undefined}
            {deployRunning || logsExpanded ? (
              <PreviewLogsTabs
                owner={repoOwner(diagnostics.logs.repoFullName)}
                repo={repoName(diagnostics.logs.repoFullName)}
                pr={diagnostics.logs.prNumber}
                appBuilding={imageBuilding}
                resetKey={attemptKey}
                viewerHeader={false}
                source={logSource}
                onSourceChange={setLogSourceOverride}
              />
            ) : undefined}
          </>
        ) : (
          <p className="font-mono text-2xs text-text-secondary">Logs appear once a deploy starts.</p>
        )
      ) : undefined}
    </div>
  );
}

/**
 * One service as the readiness poll reports it. Taken from the query output rather
 * than re-declared, so the badge cannot drift from what the API sends.
 */
type PreviewReadinessService = ReturnType<typeof usePreviewReadiness>["data"]["services"][number];

/** The deploy status as readiness reports it, likewise taken from the query output. */
type PreviewDeployStatus = ReturnType<typeof usePreviewReadiness>["data"]["diagnostics"]["status"];

/**
 * A token that changes every time a new deploy attempt begins, for the log stream to
 * restart on.
 *
 * The stream is terminal but its URL is not: once a deploy ends, the SSE connection
 * closes for good, while the URL is identical for every deploy this environment will
 * ever run. So the viewer stayed frozen on the attempt that ended, showing "failed"
 * next to a DEPLOY badge that said "building" - the same page telling two stories.
 *
 * Readiness going from a terminal status back to `building` is the only client-visible
 * sign a new attempt started. There is no attempt id to read instead: a
 * `PreviewkitBuild` row is written at FINISH and upserted per (environment, commit), so
 * a same-commit redeploy reuses the row and nothing new exists to key off at start.
 */
function useDeployAttemptKey(status: PreviewDeployStatus): string {
  const [attempt, setAttempt] = useState(0);
  const previousRef = useRef(status);
  // A transition over polled data, and a genuine side effect (throwing away a live
  // subscription's accumulated state) - which is what useEffect is for.
  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = status;
    const restarted = (previous === "ready" || previous === "failed") && status === "building";
    if (restarted) setAttempt((current) => current + 1);
  }, [status]);
  return String(attempt);
}

/**
 * The status word on a service badge. A managed service (postgres, redis, ...) is a
 * recipe the environment provisions rather than something built from the repo, so
 * "building" would describe work that never happens for it - it reads "starting".
 */
function serviceStatusLabel(service: PreviewReadinessService): string {
  if (service.kind === "managed" && service.status === "building") return "starting";
  return service.status;
}

/**
 * Human explanation of a service's status, shown on hover - the raw word alone is thin.
 *
 * `statusSource` changes what is true, not just the wording. A `cluster` verdict is
 * the workload's live replica readiness, so "ready" there means it is genuinely
 * serving; a `pipeline` verdict only means the deploy step for it succeeded, which
 * stays true even if the thing crashed a second later. Saying "up and accepting
 * connections" off a pipeline verdict would be a guess dressed as a fact.
 */
function serviceStatusHint(service: PreviewReadinessService): string {
  const managed = service.kind === "managed";
  const fromCluster = service.statusSource === "cluster";
  if (service.status === "ready") {
    return fromCluster
      ? "Running and passing its readiness checks."
      : "Deployed successfully. Autonoma hasn't confirmed it is serving yet.";
  }
  if (service.status === "building") {
    if (fromCluster) return "Started, waiting for it to report ready.";
    return managed
      ? "The preview environment is bringing this service up."
      : "This app is still being built and deployed.";
  }
  if (service.status === "idle") {
    return "Up, but scaled to zero while nothing is using it. The next request wakes it.";
  }
  if (service.status === "failed") {
    if (service.error != null) return `Not staying up: ${service.error}`;
    return managed ? "This service never came up." : "This app failed to build or deploy.";
  }
  return "Autonoma hasn't reported this service's status yet - it may still be starting.";
}

/**
 * A failed deploy attempt, told as the iteration it is.
 *
 * A build failing while an agent is setting the app up is the ordinary middle of
 * the process, not an incident: the agent reads the error, changes the config and
 * deploys again, exactly like a person would. Rendering it in critical red made a
 * run that was going fine look like the product had broken, and there is nothing
 * for the user to do about it - so the note says who is on it, and keeps the error
 * itself as dim supporting detail rather than the headline.
 *
 * Silence is the case that DOES need the user: an agent that failed and then went
 * quiet has left the app stuck, and only they can restart it. That one keeps the
 * warning tone and asks for the nudge.
 */
function FailedDeployNote({
  error,
  agentName,
  agentStalled,
}: {
  error: string;
  agentName: string;
  agentStalled: boolean;
}) {
  if (agentStalled) {
    return (
      <div className="flex items-start gap-2 border-l-2 border-status-warn bg-status-warn/10 px-3 py-2">
        <WarningCircleIcon size={14} className="mt-0.5 shrink-0 text-status-warn" />
        <div className="flex flex-col gap-1">
          <p className="text-2xs text-text-primary">
            This deploy failed and {agentName} has gone quiet without retrying.
          </p>
          <p className="font-mono text-3xs leading-relaxed text-text-secondary">{error}</p>
          <p className="text-3xs leading-relaxed text-text-secondary">
            Tell it to continue in the terminal you started it from - it cannot see this screen - or take over above and
            fix the config here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2 border-l-2 border-border-mid bg-surface-void px-3 py-2">
      <WrenchIcon size={14} className="mt-0.5 shrink-0 text-text-secondary" />
      <div className="flex flex-col gap-1">
        <p className="text-2xs text-text-primary">This deploy failed. {agentName} is working through it.</p>
        <p className="font-mono text-3xs leading-relaxed text-text-secondary">{error}</p>
        <p className="text-3xs leading-relaxed text-text-secondary">
          Builds usually take a couple of attempts to get right. Nothing for you to do unless it asks.
        </p>
      </div>
    </div>
  );
}

/**
 * The deploy's own state. A failed attempt reads as a warning rather than a
 * critical while an agent is still iterating on it - see {@link FailedDeployNote};
 * the two are deliberately the same judgement, so the badge and the note beneath
 * it cannot disagree about how alarming this is.
 */
function DeployStatusBadge({
  status,
  retrying,
}: {
  status: "idle" | "building" | "ready" | "failed";
  retrying: boolean;
}) {
  if (status === "ready") return <Badge variant="success">ready</Badge>;
  if (status === "failed") return <Badge variant={retrying ? "warn" : "critical"}>failed</Badge>;
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
 * The preview path as the session reports it, taken from the query output rather
 * than re-declared, so it cannot drift from the enum behind it.
 */
type AgentSessionPreviewMode = NonNullable<ReturnType<typeof useAgentSession>["data"]>["previewEnvironmentMode"];

/**
 * What the agent is actually doing right now. Before a path is chosen it is not
 * configuring a preview - it is reading the repo to decide whether Autonoma
 * should build previews at all - and on the customer's own pipeline it never
 * configures one. Saying "configuring your preview" through all three states
 * describes work that may never happen.
 */
function agentHeadline(client: string | undefined, mode: AgentSessionPreviewMode): string {
  const agent = agentDisplayName(client);
  if (mode == null) return `${agent} is working out how to set this up`;
  if (mode === "existing_deploys") return `${agent} is connecting your deploys`;
  return `${agent} is configuring your preview`;
}

/**
 * Which preview path the agent committed to, and why, shown above whatever that
 * path is assembling. Changing it means stopping the agent - it is mid-flight
 * building against this answer - so the link says so rather than implying the
 * choice can be swapped underneath it.
 */
function ChosenPath({
  mode,
  reason,
  appId,
}: {
  mode: "previewkit" | "existing_deploys";
  reason?: string;
  appId: string;
}) {
  return (
    <div className="flex flex-col gap-1 border border-border-dim bg-surface-void px-3 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-3xs uppercase tracking-widest text-text-secondary">Preview path</span>
        <Link
          to="/onboarding"
          search={buildOnboardingSearch("preview-environment", appId, { manual: true })}
          className="font-mono text-3xs uppercase tracking-widest text-text-secondary transition-colors hover:text-primary"
        >
          Take over and change
        </Link>
      </div>
      <span className="font-mono text-2xs text-text-primary">
        {mode === "previewkit" ? "Autonoma builds your previews" : "Your own pipeline builds them"}
      </span>
      {reason != null ? <span className="text-3xs leading-snug text-text-secondary">{reason}</span> : undefined}
    </div>
  );
}

/** Whether the agent's heartbeat has gone quiet long enough to be worth flagging. */
function isStalled(lastActivityAt: string | Date | undefined): boolean {
  if (lastActivityAt == null) return false;
  return Date.now() - new Date(lastActivityAt).getTime() > STALLED_AFTER_MS;
}

function ToolCallRow({ entry }: { entry: AgentLogEntry }) {
  // Lead with the agent's human-readable summary; the raw tool name rides along as
  // a dim mono tag for the curious. Fall back to the tool name + args only when no
  // summary was given (older entries / tools without one).
  const summary = entry.message ?? entry.tool;
  const showToolTag = entry.message != null && entry.tool != null;
  return (
    <div className="flex items-start gap-2 text-2xs">
      <ToolCallGlyph status={entry.status} />
      <span className="text-text-primary">{summary}</span>
      {showToolTag ? (
        <span className="font-mono text-text-secondary">{entry.tool}</span>
      ) : entry.toolArguments != null ? (
        <span className="truncate font-mono text-text-secondary">{JSON.stringify(entry.toolArguments)}</span>
      ) : undefined}
    </div>
  );
}

/**
 * Whether this tool call is still in flight, and nothing more.
 *
 * A tool call that errors is the agent's own business: the error goes back to it and
 * it adapts, retries, or picks another route - which is the loop working, not the
 * product failing. Scoring each call with a green tick or a red cross put our name on
 * the agent's trial and error and made a healthy run look broken. So a finished call
 * gets one neutral mark whichever way it went, and only "still running" is worth
 * distinguishing. The status is still recorded server-side for support.
 */
function ToolCallGlyph({ status }: { status?: AgentLogEntry["status"] }) {
  if (status === "running")
    return <BrailleSpinner animation="braille" size="sm" className="w-3.5 shrink-0 text-center text-primary" />;
  return <WrenchIcon className="mt-px size-3.5 shrink-0 text-text-secondary" />;
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
  // Which values are shown in plaintext. Reveal is a while-you-type aid only:
  // the values are never read back once submitted (they go straight to the
  // backend), so this state lives entirely in the form and resets on remount.
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const submitEnv = useSubmitAgentEnv();

  function setValue(key: string, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  function toggleRevealed(key: string) {
    setRevealed((current) => ({ ...current, [key]: !current[key] }));
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
            <div className="relative">
              <Input
                aria-label={`Value for ${key}`}
                type={revealed[key] ? "text" : "password"}
                value={values[key] ?? ""}
                onChange={(event) => setValue(key, event.target.value)}
                placeholder="Value"
                className="pr-9 font-mono"
              />
              <button
                type="button"
                title={revealed[key] ? "Hide value" : "Reveal value"}
                aria-label={revealed[key] ? `Hide value for ${key}` : `Reveal value for ${key}`}
                onClick={() => toggleRevealed(key)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-text-secondary transition-colors hover:text-text-primary"
              >
                {revealed[key] ? <EyeSlashIcon size={14} /> : <EyeIcon size={14} />}
              </button>
            </div>
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
