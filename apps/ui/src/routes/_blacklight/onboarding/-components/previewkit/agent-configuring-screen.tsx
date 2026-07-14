import { Badge, Button, Progress, ScrollArea, Separator, Textarea } from "@autonoma/blacklight";
import type { AgentLogEntry } from "@autonoma/types";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { CircleIcon } from "@phosphor-icons/react/Circle";
import { PlugsConnectedIcon } from "@phosphor-icons/react/PlugsConnected";
import { SpinnerGapIcon } from "@phosphor-icons/react/SpinnerGap";
import { StopIcon } from "@phosphor-icons/react/Stop";
import { XCircleIcon } from "@phosphor-icons/react/XCircle";
import { useAgentSession, useStopAgent, useSubmitAgentEnv } from "lib/onboarding/onboarding-api";
import { useState } from "react";
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
            {ready ? "Your preview is live" : "Claude is configuring your preview"}
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

      <p className="text-2xs text-text-secondary">
        The configuration below fills itself in as the agent works - you don't need to touch it.
      </p>
    </div>
  );
}

function ToolCallRow({ entry }: { entry: AgentLogEntry }) {
  return (
    <div className="flex items-start gap-2 font-mono text-2xs">
      <StatusGlyph status={entry.status} />
      <span className="text-text-primary">{entry.tool ?? entry.message}</span>
      {entry.toolArguments != null && (
        <span className="truncate text-text-secondary">{JSON.stringify(entry.toolArguments)}</span>
      )}
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
