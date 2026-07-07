import { Badge, Card, cn } from "@autonoma/blacklight";
import { CircleNotchIcon } from "@phosphor-icons/react/CircleNotch";
import { TerminalWindowIcon } from "@phosphor-icons/react/TerminalWindow";
import { useEffect, useRef } from "react";
import { env } from "../../env";
import { type BuildLogConnection, type BuildLogEntry, useBuildLogStream } from "./use-build-log-stream";

interface BuildLogStreamViewerProps {
  /** Fully-formed SSE endpoint URL. See {@link buildPreviewLogStreamUrl}. */
  url?: string | undefined;
  /** Extra request headers, e.g. `{ Authorization: "Bearer <token>" }`. */
  headers?: Record<string, string> | undefined;
  /** Header label; defaults to the build-log wording. */
  title?: string | undefined;
  /** Empty-state text while waiting for the first entry. */
  waitingText?: string | undefined;
  /** When true, the viewer grows to fill its flex parent instead of using a fixed body height. */
  fill?: boolean | undefined;
  className?: string | undefined;
}

/**
 * Isolated, drop-in viewer for a build-log SSE stream - a reference for wiring
 * live logs into a page. It owns no routing or data-layer assumptions: give it
 * a `url` and it renders a terminal-style, auto-scrolling log with phase markers
 * and a live status badge. All consumption logic lives in `useBuildLogStream`.
 */
export function BuildLogStreamViewer({
  url,
  headers,
  title = "build logs",
  waitingText = "waiting for build output…",
  fill,
  className,
}: BuildLogStreamViewerProps) {
  const { entries, phase, buildStatus, connection, error } = useBuildLogStream({ url, headers });
  const bodyRef = useRef<HTMLDivElement>(null);

  // Stick to the bottom as new lines stream in. Direct DOM scroll control is a
  // true side effect, so a ref + effect is the right tool here.
  useEffect(() => {
    const node = bodyRef.current;
    if (node != null) node.scrollTop = node.scrollHeight;
  }, [entries]);

  return (
    <Card className={cn("flex flex-col overflow-hidden", fill === true && "min-h-0 flex-1", className)}>
      <header className="flex items-center gap-2 border-b border-border-dim px-4 py-2">
        <TerminalWindowIcon className="size-4 text-text-secondary" weight="duotone" />
        <span className="font-mono text-2xs text-text-secondary">{title}</span>
        <div className="ml-auto flex items-center gap-2">
          {phase != null && <span className="font-mono text-3xs text-text-secondary">{phase}</span>}
          <StatusBadge connection={connection} buildStatus={buildStatus} error={error} />
        </div>
      </header>

      <div
        ref={bodyRef}
        className={cn(
          fill === true ? "min-h-0 flex-1" : "h-80",
          "overflow-y-auto bg-surface-void px-4 py-3 font-mono text-2xs leading-relaxed",
        )}
      >
        {entries.length === 0 ? (
          <EmptyState connection={connection} error={error} waitingText={waitingText} />
        ) : (
          entries.map((entry) => <LogRow key={entry.id} entry={entry} />)
        )}
      </div>
    </Card>
  );
}

function LogRow({ entry }: { entry: BuildLogEntry }) {
  if (entry.kind === "phase") {
    return <div className="mt-2 mb-1 text-primary">▸ {entry.message}</div>;
  }
  if (entry.kind === "status") {
    const succeeded = entry.message === "ready";
    return (
      <div className={cn("mt-2", succeeded ? "text-status-success" : "text-status-critical")}>
        {succeeded ? "✓" : "✗"} build {entry.message}
      </div>
    );
  }
  const timestamp = formatLogTimestamp(entry.id);
  return (
    <div className="flex items-start gap-3">
      <span className="w-24 shrink-0 select-none text-text-secondary/70" title={timestamp?.full}>
        {timestamp?.time ?? ""}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 whitespace-pre-wrap break-words",
          entry.stream === "stderr" ? "text-status-warn" : "text-text-secondary",
        )}
      >
        {entry.message}
      </span>
    </div>
  );
}

/**
 * Render a log entry's id as a local wall-clock time. Loki tags every entry with
 * a nanosecond epoch (relayed verbatim as the SSE id), so `time` is `HH:MM:SS.mmm`
 * and `full` (for the hover tooltip) is the complete local date-time. Returns
 * `undefined` for the rare non-Loki id - the `seq-*` placeholder the stream hook
 * assigns when an SSE message arrives without an id.
 */
function formatLogTimestamp(id: string): { time: string; full: string } | undefined {
  if (!/^\d+$/.test(id)) return undefined;
  const date = new Date(Number(id) / 1e6);
  if (Number.isNaN(date.getTime())) return undefined;
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return { time: `${hh}:${mm}:${ss}.${ms}`, full: date.toLocaleString() };
}

function StatusBadge({
  connection,
  buildStatus,
  error,
}: {
  connection: BuildLogConnection;
  buildStatus: string | undefined;
  error: string | undefined;
}) {
  if (error != null) return <Badge variant="critical">error</Badge>;
  if (buildStatus === "ready") return <Badge variant="success">ready</Badge>;
  if (buildStatus === "failed") return <Badge variant="destructive">failed</Badge>;
  if (buildStatus != null) return <Badge variant="secondary">{buildStatus}</Badge>;

  if (connection === "open") {
    return (
      <Badge variant="status-running" className="gap-1">
        <CircleNotchIcon className="size-3 animate-spin" />
        streaming
      </Badge>
    );
  }
  if (connection === "reconnecting") return <Badge variant="warn">reconnecting</Badge>;
  if (connection === "connecting") return <Badge variant="secondary">connecting</Badge>;
  return <Badge variant="secondary">closed</Badge>;
}

function EmptyState({
  connection,
  error,
  waitingText,
}: {
  connection: BuildLogConnection;
  error: string | undefined;
  waitingText: string;
}) {
  if (error != null) return <div className="text-status-critical">{error}</div>;
  return (
    <div className="flex items-center gap-2 text-text-secondary">
      <CircleNotchIcon className="size-3 animate-spin" />
      {connection === "reconnecting" ? "reconnecting…" : waitingText}
    </div>
  );
}

/**
 * Example wrapper: resolves the SSE URL from (owner, repo, pr), attaches a
 * bearer token, and renders the viewer. This is the piece the frontend team
 * adapts to wherever build logs should appear (e.g. a deployment detail page) -
 * swap `accessToken` for however the app sources its previewkit credential.
 */
export function PreviewBuildLogStreamExample({
  owner,
  repo,
  pr,
  accessToken,
}: {
  owner: string;
  repo: string;
  pr: number;
  accessToken?: string;
}) {
  const headers = accessToken != null ? { Authorization: `Bearer ${accessToken}` } : undefined;
  return <BuildLogStreamViewer url={buildPreviewLogStreamUrl(owner, repo, pr)} headers={headers} />;
}

/**
 * Builds the previewkit log-stream SSE URL, mirroring how `lib/trpc` picks its
 * base: same-origin in production, absolute `VITE_API_URL` in cross-origin
 * preview environments. `source` selects build output (default) or the
 * environment's runtime app stdout/stderr; `app`, when set, narrows the stream
 * to a single app's logs; `filter`, when set, is a case-insensitive substring
 * the server matches against each line so only matching lines stream.
 */
export function buildPreviewLogStreamUrl(
  owner: string,
  repo: string,
  pr: number,
  source: "build" | "app" = "build",
  app?: string,
  filter?: string,
): string {
  const params = new URLSearchParams();
  if (source === "app") params.set("source", "app");
  if (app != null && app !== "") params.set("app", app);
  if (filter != null && filter !== "") params.set("filter", filter);
  const query = params.toString();
  const path = `/v1/previewkit/environments/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${pr}/logs/stream${query !== "" ? `?${query}` : ""}`;
  const isPreviewEnvironment = window.location.hostname.endsWith(`.preview.${env.VITE_INTERNAL_DOMAIN}`);
  return isPreviewEnvironment ? `${env.VITE_API_URL}${path}` : path;
}
