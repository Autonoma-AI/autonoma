import { Badge, BrailleSpinner, Card, cn } from "@autonoma/blacklight";
import { CircleNotchIcon } from "@phosphor-icons/react/CircleNotch";
import { TerminalWindowIcon } from "@phosphor-icons/react/TerminalWindow";
import { XCircleIcon } from "@phosphor-icons/react/XCircle";
import { useEffect, useRef } from "react";
import { env } from "../../env";
import { parseAnsi } from "./parse-ansi";
import { type BuildLogConnection, type BuildLogEntry, useBuildLogStream } from "./use-build-log-stream";

const STICK_TO_BOTTOM_THRESHOLD_PX = 32;

// Only "stdout"/"stderr" is available on a log entry - no server-side info/warn/error taxonomy exists,
// and this file deliberately avoids content-keyword heuristics (see the stream-not-content comment on
// `LogRow` below), so the filter has exactly two real severities. "Info" is the floor, so it shows
// everything - same as "all" - and only "Error" (stderr) narrows the view.
export type LogLevelFilter = "all" | "info" | "error";

const LOG_LEVEL_RANK: Record<Exclude<LogLevelFilter, "all">, number> = { info: 1, error: 2 };

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
  /** When false, hides the inner title/status header - use when an outer layout (tabs, page title) already labels the stream and a footer shows status instead. Defaults to true. */
  header?: boolean | undefined;
  /** When true, appends a footer with connection/build status and shown/total/error line counts. Defaults to false. */
  footer?: boolean | undefined;
  /** Only show log entries at or above this severity; phase/status markers always show regardless. Defaults to "all". */
  levelFilter?: LogLevelFilter | undefined;
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
  header = true,
  footer = false,
  levelFilter = "all",
  className,
}: BuildLogStreamViewerProps) {
  const { entries, phase, buildStatus, connection, error } = useBuildLogStream({ url, headers });
  const bodyRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  // While the deploy is still running, mark the latest phase (e.g. "deploying-services")
  // as active so it renders a live spinner instead of a static marker that reads as stuck.
  const deployInFlight =
    error == null && buildStatus !== "ready" && buildStatus !== "failed" && connection !== "closed";
  const lastPhaseId = [...entries].reverse().find((entry) => entry.kind === "phase")?.id;

  const visibleEntries = entries.filter((entry) => matchesLevelFilter(entry, levelFilter));
  const errorCount = entries.filter((entry) => entry.kind === "log" && deriveLogLevel(entry) === "error").length;

  const handleScroll = () => {
    const node = bodyRef.current;
    if (node == null) return;
    const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    stickToBottomRef.current = distanceFromBottom <= STICK_TO_BOTTOM_THRESHOLD_PX;
  };

  useEffect(() => {
    const node = bodyRef.current;
    if (node != null && stickToBottomRef.current) node.scrollTop = node.scrollHeight;
  }, [entries]);

  return (
    <Card className={cn("flex flex-col overflow-hidden", fill === true && "min-h-0 flex-1 gap-0", className)}>
      {header && (
        <header className="flex shrink-0 items-center gap-2 border-b border-border-dim px-4 py-2">
          <TerminalWindowIcon className="size-4 text-text-secondary" weight="duotone" />
          <span className="font-mono text-2xs text-text-secondary">{title}</span>
          <div className="ml-auto flex items-center gap-2">
            {phase != null && <span className="font-mono text-3xs text-text-secondary">{phase}</span>}
            <StatusBadge connection={connection} buildStatus={buildStatus} error={error} />
          </div>
        </header>
      )}

      <div
        ref={bodyRef}
        onScroll={handleScroll}
        className={cn(
          fill === true ? "min-h-0 flex-1" : "h-80",
          "overflow-y-auto bg-surface-void px-4 py-3 font-mono text-2xs leading-relaxed",
        )}
      >
        {visibleEntries.length === 0 ? (
          <EmptyState connection={connection} error={error} waitingText={waitingText} filtered={entries.length > 0} />
        ) : (
          visibleEntries.map((entry) => (
            <LogRow key={entry.id} entry={entry} active={entry.id === lastPhaseId && deployInFlight} />
          ))
        )}
      </div>

      {footer && (
        <footer className="flex shrink-0 items-center gap-3 border-t border-border-dim px-4 py-2 font-mono text-3xs text-text-secondary">
          <StatusBadge connection={connection} buildStatus={buildStatus} error={error} />
          {phase != null && <span>{phase}</span>}
          <span className="ml-auto tabular-nums">
            {visibleEntries.length} / {entries.length} lines
          </span>
          <span className={cn("inline-flex items-center gap-1", errorCount > 0 && "text-status-critical")}>
            <XCircleIcon size={12} />
            {errorCount} {errorCount === 1 ? "error" : "errors"}
          </span>
        </footer>
      )}
    </Card>
  );
}

function LogRow({ entry, active }: { entry: BuildLogEntry; active?: boolean }) {
  if (entry.kind === "phase") {
    return (
      <div className="mt-2 mb-1 flex items-center gap-1.5 text-primary">
        <span className="inline-flex w-3 shrink-0 justify-center">
          {active === true ? <BrailleSpinner animation="braille" size="sm" /> : <span aria-hidden>▸</span>}
        </span>
        {entry.message}
      </div>
    );
  }
  if (entry.kind === "status") {
    const succeeded = entry.message === "ready";
    // This terminal marker is the whole deploy pipeline's outcome (it fires after
    // the image build, during rollout), so label it "deployment" - a runtime/rollout
    // failure here is NOT a build failure even though it rides the build-log stream.
    return (
      <div className={cn("mt-2", succeeded ? "text-status-success" : "text-status-critical")}>
        {succeeded ? "✓" : "✗"} deployment {entry.message}
      </div>
    );
  }
  // A single log entry can carry a multi-line chunk - build tools (and any process that
  // writes several lines in one flush) emit them as one Loki entry. Render each physical
  // line as its own timestamped row so lines aren't clumped under one timestamp.
  //
  // Color by stream, not by content: an `stderr` line reads as an error (red), everything
  // else stays the default tone. Keying off the stream avoids the false positives a keyword
  // heuristic produces (e.g. a "0 errors" summary line rendering red).
  const timestamp = formatLogTimestamp(entry.id);
  return (
    <>
      {splitLines(entry.message).map((line, index) => (
        <div key={`${entry.id}-${index}`} className="flex items-start gap-3">
          <span className="w-24 shrink-0 select-none text-text-secondary/70" title={timestamp?.full}>
            {timestamp?.time ?? ""}
          </span>
          {/* stderr sets the row's base color; ANSI segments override per span, plain text inherits. */}
          <span
            className={cn(
              "min-w-0 flex-1 whitespace-pre-wrap break-words",
              entry.stream === "stderr" ? "text-status-critical" : "text-text-secondary",
            )}
          >
            {parseAnsi(line).map((segment, segmentIndex) => (
              <span key={segmentIndex} className={segment.className}>
                {segment.text}
              </span>
            ))}
          </span>
        </div>
      ))}
    </>
  );
}

// Same "color by stream, not by content" reasoning as `LogRow` - `stderr` is the only real error
// signal available, so that's what the level filter and the footer's error count key off too.
export function deriveLogLevel(entry: BuildLogEntry): "info" | "error" {
  return entry.stream === "stderr" ? "error" : "info";
}

export function matchesLevelFilter(entry: BuildLogEntry, levelFilter: LogLevelFilter): boolean {
  if (levelFilter === "all" || entry.kind !== "log") return true;
  return LOG_LEVEL_RANK[deriveLogLevel(entry)] >= LOG_LEVEL_RANK[levelFilter];
}

/**
 * Split a log entry's message into physical lines. Nearly every log write ends in a
 * newline, so a single trailing empty line is dropped to avoid a spurious blank row;
 * interior blank lines are kept, since build output uses them for spacing.
 */
function splitLines(message: string): string[] {
  const lines = message.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
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
  filtered,
}: {
  connection: BuildLogConnection;
  error: string | undefined;
  waitingText: string;
  /** True when entries have arrived but the level filter matched none of them - a different message than "still waiting". */
  filtered: boolean;
}) {
  if (error != null) return <div className="text-status-critical">{error}</div>;
  if (filtered) return <div className="text-text-secondary">No log lines match the current filter.</div>;
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
