import { Tabs, TabsContent, TabsList, TabsTrigger, cn } from "@autonoma/blacklight";
import { BuildLogStreamViewer, buildPreviewLogStreamUrl } from "./build-log-stream-viewer";

interface PreviewLogsTabsProps {
  owner: string;
  repo: string;
  pr: number;
  /** Extra request headers, e.g. `{ Authorization: "Bearer <token>" }`. */
  headers?: Record<string, string> | undefined;
  className?: string | undefined;
}

/**
 * Logs for one preview environment as two tabs: the build output (Redis-backed
 * stream) and the running apps' stdout/stderr (Loki-backed, `?source=app`).
 * Radix only mounts the active tab's content, so each SSE stream opens on
 * demand and closes when the user switches away.
 */
export function PreviewLogsTabs({ owner, repo, pr, headers, className }: PreviewLogsTabsProps) {
  return (
    <Tabs defaultValue="build" className={cn("gap-2", className)}>
      <TabsList>
        <TabsTrigger value="build">Build logs</TabsTrigger>
        <TabsTrigger value="app">App logs</TabsTrigger>
      </TabsList>
      <TabsContent value="build">
        <BuildLogStreamViewer url={buildPreviewLogStreamUrl(owner, repo, pr)} headers={headers} />
      </TabsContent>
      <TabsContent value="app">
        <BuildLogStreamViewer
          url={buildPreviewLogStreamUrl(owner, repo, pr, "app")}
          headers={headers}
          title="app logs"
          waitingText="waiting for application output…"
        />
      </TabsContent>
    </Tabs>
  );
}
