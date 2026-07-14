import { Badge, Button, Progress, ScrollArea, Separator, Skeleton, Textarea } from "@autonoma/blacklight";
import { type AgentLogEntry, isPreviewkitDatabaseEngine } from "@autonoma/types";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { CircleIcon } from "@phosphor-icons/react/Circle";
import { GlobeIcon } from "@phosphor-icons/react/Globe";
import { PlugsConnectedIcon } from "@phosphor-icons/react/PlugsConnected";
import { SpinnerGapIcon } from "@phosphor-icons/react/SpinnerGap";
import { StopIcon } from "@phosphor-icons/react/Stop";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { XCircleIcon } from "@phosphor-icons/react/XCircle";
import { PreviewLogsTabs, type PreviewLogSource } from "components/build-logs/preview-logs-tabs";
import {
  useAgentSession,
  usePreviewkitConfig,
  usePreviewReadiness,
  useStopAgent,
  useSubmitAgentEnv,
} from "lib/onboarding/onboarding-api";
import { Suspense, useState, type ReactNode } from "react";
import { parseDotenv } from "./topology-draft";

/**
 * The read-only "Claude is configuring your preview" screen shown while a coding
 * agent holds the config (over the onboarding MCP). Polls the session, streams the
 * agent's tool calls, surfaces any question the agent raised (env values), and
 * lets the user take over. The parent decides when to render this (agent holds);
 * once the user takes over, the parent swaps back to the editable form.
 */
export function AgentConfiguringScreen({ applicationId }: { applicationId: string }) {
  const { data: session } = useAgentSession(applicationId);
  const stopAgent = useStopAgent();

  if (session == null) return undefined;

  const logs = session.logs;
  const doneCount = logs.filter((entry) => entry.status === "done").length;
  const total = logs.length;
  const running = [...logs].reverse().find((entry) => entry.status === "running");
  const ready = session.previewVerificationStatus === "ready";
  const pendingEnv = session.pendingRequest?.kind === "env" ? session.pendingRequest : undefined;

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
          applicationId={applicationId}
          appName={pendingEnv.appName}
          keys={pendingEnv.keys}
          note={pendingEnv.note}
        />
      )}

      <Separator />

      <ScrollArea className="max-h-80">
        <div className="flex flex-col gap-1.5">
          {logs.length === 0 ? (
            <p className="font-mono text-2xs text-text-secondary">Waiting for the agent to start…</p>
          ) : (
            logs.map((entry) => <ToolCallRow key={entry.id} entry={entry} />)
          )}
        </div>
      </ScrollArea>

      <Separator />

      <Suspense fallback={<Skeleton className="h-24 w-full" />}>
        <ConfigSummary applicationId={applicationId} />
      </Suspense>

      <Separator />

      <Suspense fallback={<Skeleton className="h-48 w-full" />}>
        <DeploySection applicationId={applicationId} />
      </Suspense>
    </div>
  );
}

/** Section heading used inside the read-only configuring screen. */
function SectionTitle({ children }: { children: ReactNode }) {
  return <p className="font-mono text-2xs uppercase tracking-widest text-text-secondary">{children}</p>;
}

/**
 * A read-only summary of the config the agent has written so far, so the user can
 * see what it set up (apps + framework + port + secret keys, services, addons)
 * without an editable panel they are told not to touch.
 */
function ConfigSummary({ applicationId }: { applicationId: string }) {
  const { data } = usePreviewkitConfig(applicationId);
  const document = data.document;
  const apps = document?.apps ?? [];

  if (apps.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <SectionTitle>Configuration</SectionTitle>
        <p className="font-mono text-2xs text-text-secondary">The agent hasn't written a configuration yet…</p>
      </div>
    );
  }

  const services = document?.services ?? [];
  const addons = document?.addons ?? [];

  return (
    <div className="flex flex-col gap-3">
      <SectionTitle>Configuration</SectionTitle>
      <div className="flex flex-col gap-2">
        {apps.map((app) => (
          <div key={app.name} className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-2xs">
            <span className="text-text-primary">{app.name}</span>
            {app.build != null ? <Badge variant="outline">{app.build.framework}</Badge> : undefined}
            <span className="text-text-secondary">port {app.port}</span>
            {app.build_secrets.length > 0 ? (
              <span className="text-text-secondary">· secrets: {app.build_secrets.join(", ")}</span>
            ) : undefined}
          </div>
        ))}
        {services.map((service) => (
          <div key={service.name} className="flex items-center gap-2 font-mono text-2xs">
            {/* A database recipe (postgres/redis/valkey/mysql/mongodb) is a "database" to
                the user even though it is stored as a service - label it as such. */}
            <Badge variant="secondary">{isPreviewkitDatabaseEngine(service.recipe) ? "database" : "service"}</Badge>
            <span className="text-text-primary">{service.name}</span>
            <span className="text-text-secondary">{service.recipe}</span>
          </div>
        ))}
        {addons.map((addon) => (
          <div key={addon.name} className="flex items-center gap-2 font-mono text-2xs">
            <Badge variant="secondary">addon</Badge>
            <span className="text-text-primary">{addon.name}</span>
            <span className="text-text-secondary">{addon.provider}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The live deploy status and logs, shown read-only below the activity stream (no
 * redeploy/edit actions - the agent drives). Surfaces the same build/app log tabs
 * the deploy-verify screen uses, so the user can watch the deploy and see failures
 * as they happen instead of a bare spinner.
 */
function DeploySection({ applicationId }: { applicationId: string }) {
  const { data } = usePreviewReadiness(applicationId);
  const { diagnostics, previewUrl, services } = data;
  const isReady = diagnostics.status === "ready";
  const appBuilding = diagnostics.status === "building" || diagnostics.status === "idle";
  // Follow the deploy: watch the build until the container is up, then switch to app
  // logs. Only "ready" flips to app - a "failed" deploy keeps the build tab, because
  // the terminal failure marker is pushed to the build stream (the app stream is empty
  // on a build or platform failure). An explicit tab pick sticks.
  const [logSourceOverride, setLogSourceOverride] = useState<PreviewLogSource | undefined>(undefined);
  const logSource: PreviewLogSource = logSourceOverride ?? (isReady ? "app" : "build");
  const isFailed = diagnostics.status === "failed";

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
            <Badge
              key={service.name}
              variant="outline"
              className="gap-1.5 font-mono"
              title={serviceStatusHint(service.status)}
            >
              {service.name}
              <span className="text-text-secondary">{service.status}</span>
            </Badge>
          ))}
        </div>
      ) : undefined}

      {diagnostics.logs.available ? (
        <PreviewLogsTabs
          owner={repoOwner(diagnostics.logs.repoFullName)}
          repo={repoName(diagnostics.logs.repoFullName)}
          pr={diagnostics.logs.prNumber}
          appBuilding={appBuilding}
          source={logSource}
          onSourceChange={setLogSourceOverride}
        />
      ) : (
        <p className="font-mono text-2xs text-text-secondary">Logs appear once a deploy starts.</p>
      )}
    </div>
  );
}

/** Human explanation of a preview service's status, shown on hover - the raw word alone (e.g. "unknown") is opaque. */
function serviceStatusHint(status: "ready" | "building" | "failed" | "unknown"): string {
  if (status === "ready") return "This service is up and accepting connections.";
  if (status === "building") return "This service is still starting up.";
  if (status === "failed") return "This service failed to start.";
  return "PreviewKit hasn't reported this service's status yet - it may still be starting.";
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
 * The inline env-value form the agent's request surfaces. The user pastes their
 * .env (parsed client-side; comments stripped) or the values never leave the
 * browser for the agent - they go straight to the backend. Shows the keys the
 * agent asked for.
 */
function EnvRequestForm({
  applicationId,
  appName,
  keys,
  note,
}: {
  applicationId: string;
  appName: string;
  keys: string[];
  note?: string;
}) {
  const [text, setText] = useState("");
  const submitEnv = useSubmitAgentEnv();
  // Only the keys the agent actually asked for are sent - never persist unrelated
  // secrets the user happens to have pasted in their .env.
  const requested = new Set(keys);
  const items = parseDotenv(text).filter((row) => requested.has(row.key));
  // The agent's request_env contract reads a cleared pending request as "all keys
  // are set", so a partial submit would let it deploy with missing secrets. Gate on
  // set-membership, not count: a pasted .env with a duplicate key would pass a
  // length check while a requested key is still missing.
  const provided = new Set(items.map((row) => row.key));
  const allKeysMatched = keys.every((key) => provided.has(key));

  function submit() {
    if (!allKeysMatched) return;
    submitEnv.mutate({ applicationId, appName, items });
  }

  return (
    <div className="flex flex-col gap-2 border border-primary/40 bg-surface-raised p-4">
      <p className="text-2xs text-text-primary">
        Claude needs these environment values for <span className="font-mono">{appName}</span>. Paste your{" "}
        <span className="font-mono">.env</span> (values stay in your browser and go straight to Autonoma - the agent
        never sees them).
      </p>
      {note != null && <p className="text-2xs text-text-secondary">{note}</p>}
      <div className="flex flex-wrap gap-1">
        {keys.map((key) => (
          <Badge key={key} variant="outline" className="font-mono">
            {key}
          </Badge>
        ))}
      </div>
      <Textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="KEY=value"
        className="min-h-24 font-mono text-2xs"
      />
      {submitEnv.isError && (
        <p className="text-2xs text-status-critical">
          {submitEnv.error?.message ?? "Failed to set the values. Check the keys and try again."}
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        <span className="mr-auto font-mono text-3xs text-text-secondary">
          {provided.size} of {keys.length} requested key(s) matched
        </span>
        <Button size="sm" onClick={submit} disabled={!allKeysMatched || submitEnv.isPending}>
          Set on Autonoma
        </Button>
      </div>
    </div>
  );
}
