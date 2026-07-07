import { Button, Input, Tabs, TabsContent, TabsList, TabsTrigger, cn } from "@autonoma/blacklight";
import { CircleNotchIcon } from "@phosphor-icons/react/CircleNotch";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/MagnifyingGlass";
import { XIcon } from "@phosphor-icons/react/X";
import { useEffect, useState } from "react";
import { BuildLogStreamViewer, buildPreviewLogStreamUrl } from "./build-log-stream-viewer";

// Wait for a pause in typing before applying the search, so each keystroke does not
// reopen the SSE stream (a filter change is a new server-side query from the cursor).
const SEARCH_DEBOUNCE_MS = 300;

/** Which log stream the tabs show: the build output or the running app's output. */
export type PreviewLogSource = "build" | "app";

interface PreviewLogsTabsProps {
  owner: string;
  repo: string;
  pr: number;
  /** When set, both tabs stream only this app's logs instead of the whole environment's. */
  app?: string | undefined;
  /** When true, the app is still building, so the App logs tab shows a placeholder (no runtime logs yet). */
  appBuilding?: boolean | undefined;
  /** When true, the tabs grow to fill their flex parent (full-height layout) instead of a fixed body height. */
  fill?: boolean | undefined;
  /** Extra request headers, e.g. `{ Authorization: "Bearer <token>" }`. */
  headers?: Record<string, string> | undefined;
  /** Controls the active tab. When omitted, the tabs are uncontrolled and default to App logs. */
  source?: PreviewLogSource | undefined;
  /** Called when the user switches tabs - use it to persist the choice (e.g. in the URL). */
  onSourceChange?: ((source: PreviewLogSource) => void) | undefined;
  className?: string | undefined;
}

/**
 * Logs for one preview environment as two tabs: the build output (Redis-backed
 * stream) and the running apps' stdout/stderr (Loki-backed, `?source=app`).
 * Radix only mounts the active tab's content, so each SSE stream opens on
 * demand and closes when the user switches away.
 *
 * App logs are the default focus - the build output is the secondary tab.
 */
export function PreviewLogsTabs({
  owner,
  repo,
  pr,
  app,
  appBuilding,
  fill,
  headers,
  source,
  onSourceChange,
  className,
}: PreviewLogsTabsProps) {
  const contentClassName = fill === true ? "flex min-h-0 flex-col" : undefined;
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  // Debounce the search box: only the settled value drives the stream URL.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  // The search hasn't taken effect yet while the debounce is still settling; show a
  // spinner in place of the search icon so the control's state is legible.
  const isSearchPending = search !== debouncedSearch;
  const filter = debouncedSearch.trim() === "" ? undefined : debouncedSearch.trim();
  const appWaitingText =
    filter != null ? `no application logs match “${filter}” yet…` : "waiting for application output…";
  const buildWaitingText = filter != null ? `no build logs match “${filter}” yet…` : undefined;

  return (
    <Tabs
      value={source}
      defaultValue="app"
      onValueChange={(value) => onSourceChange?.(value === "build" ? "build" : "app")}
      className={cn("gap-2", fill === true && "min-h-0 flex-1", className)}
    >
      <div className="flex items-center gap-3">
        <TabsList>
          <TabsTrigger value="app">App logs</TabsTrigger>
          <TabsTrigger value="build">Build logs</TabsTrigger>
        </TabsList>
        <div className="relative ml-auto w-full max-w-xs">
          {isSearchPending ? (
            <CircleNotchIcon
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 animate-spin text-text-secondary"
            />
          ) : (
            <MagnifyingGlassIcon
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-secondary"
            />
          )}
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search logs…"
            aria-label="Search logs"
            className="h-8 pr-8 pl-8 font-mono text-2xs"
          />
          {search !== "" && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => setSearch("")}
              aria-label="Clear search"
              className="absolute right-1 top-1/2 -translate-y-1/2"
            >
              <XIcon size={12} />
            </Button>
          )}
        </div>
      </div>
      <TabsContent value="app" className={contentClassName}>
        {appBuilding === true ? (
          <AppLogsBuildingPlaceholder fill={fill} />
        ) : (
          <BuildLogStreamViewer
            url={buildPreviewLogStreamUrl(owner, repo, pr, "app", app, filter)}
            headers={headers}
            title="app logs"
            waitingText={appWaitingText}
            fill={fill}
          />
        )}
      </TabsContent>
      <TabsContent value="build" className={contentClassName}>
        <BuildLogStreamViewer
          url={buildPreviewLogStreamUrl(owner, repo, pr, "build", app, filter)}
          headers={headers}
          waitingText={buildWaitingText}
          fill={fill}
        />
      </TabsContent>
    </Tabs>
  );
}

// Runtime (app) logs only exist once the container is running, so while the app is still building
// the App logs tab shows this instead of an indefinite "waiting for output" spinner.
function AppLogsBuildingPlaceholder({ fill }: { fill?: boolean | undefined }) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 border border-border-dim bg-surface-void px-4 text-center",
        fill === true ? "min-h-0 flex-1" : "h-80",
      )}
    >
      <CircleNotchIcon className="size-4 animate-spin text-text-secondary" />
      <p className="font-mono text-2xs text-text-secondary">App logs will appear once the app finishes building.</p>
    </div>
  );
}
