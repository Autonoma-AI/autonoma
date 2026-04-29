import { Badge, Panel, PanelBody, PanelHeader, PanelTitle, Skeleton } from "@autonoma/blacklight";
import { Image } from "@phosphor-icons/react/Image";
import { Play } from "@phosphor-icons/react/Play";
import { formatDate } from "lib/format";
import { useRuns } from "lib/query/runs.queries";
import { AppLink } from "../../-app-link";

type RunStatus = "pending" | "running" | "success" | "failed";

function toRunBadgeVariant(status: RunStatus) {
  switch (status) {
    case "success":
      return "success" as const;
    case "failed":
      return "critical" as const;
    case "running":
      return "status-running" as const;
    case "pending":
      return "status-pending" as const;
  }
}

function toRunStatusLabel(status: RunStatus) {
  switch (status) {
    case "success":
      return "Passed";
    case "failed":
      return "Failed";
    case "running":
      return "Running";
    case "pending":
      return "Pending";
  }
}

const TH = "px-4 py-2.5 text-left font-mono text-2xs font-medium uppercase tracking-widest text-text-tertiary";

export function RecentRunsTable() {
  const { data: runs } = useRuns();

  const recent = runs.slice(0, 5);

  return (
    <Panel className="flex flex-1 flex-col overflow-hidden">
      <PanelHeader className="flex items-center gap-2">
        <Play size={14} className="text-text-tertiary" />
        <PanelTitle>Recent runs</PanelTitle>
        <span className="ml-auto font-mono text-2xs text-text-tertiary">{runs.length} total</span>
      </PanelHeader>

      <PanelBody className="flex-1 overflow-auto p-0">
        <table className="w-full min-w-100 table-fixed text-sm">
          <thead className="sticky top-0 z-10 border-b border-border-dim bg-surface-base">
            <tr>
              <th className={`${TH} w-5/12`}>Name</th>
              <th className={`${TH} w-2/12`}>Status</th>
              <th className={`${TH} w-2/12`}>Duration</th>
              <th className={`${TH} w-3/12`}>Started</th>
            </tr>
          </thead>
          <tbody>
            {recent.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-10 text-center text-sm text-text-tertiary">
                  No runs yet - trigger your first one!
                </td>
              </tr>
            )}
            {recent.map((run) => (
              <AppLink
                key={run.id}
                to="/app/$appSlug/runs/$runId"
                params={{ runId: run.id }}
                className="table-row cursor-pointer border-b border-border-dim transition-colors last:border-0 hover:bg-surface-raised"
              >
                <td className="px-4 py-2.5 align-middle">
                  <div className="flex min-w-0 items-center gap-2">
                    {run.lastScreenshot != null ? (
                      <img
                        src={run.lastScreenshot}
                        alt=""
                        className="hidden h-8 w-12 shrink-0 border border-border-dim object-cover object-top sm:block"
                      />
                    ) : (
                      <div className="hidden h-8 w-12 shrink-0 items-center justify-center border border-border-dim bg-surface-raised sm:flex">
                        <Image size={12} className="text-text-tertiary opacity-30" />
                      </div>
                    )}
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate text-sm font-medium text-text-primary">{run.name}</span>
                      <span className="font-mono text-2xs text-text-tertiary">{run.shortId}</span>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-2.5 align-middle">
                  <Badge variant={toRunBadgeVariant(run.status as RunStatus)}>
                    {toRunStatusLabel(run.status as RunStatus)}
                  </Badge>
                </td>
                <td className="px-4 py-2.5 align-middle">
                  <span className="font-mono text-sm text-text-secondary">{run.duration ?? "\u2014"}</span>
                </td>
                <td className="px-4 py-2.5 align-middle">
                  <span className="whitespace-nowrap text-sm text-text-secondary">
                    {run.startedAt != null ? formatDate(new Date(run.startedAt)) : "\u2014"}
                  </span>
                </td>
              </AppLink>
            ))}
          </tbody>
        </table>
      </PanelBody>
    </Panel>
  );
}

export function RecentRunsTableSkeleton() {
  return (
    <Panel className="flex flex-1 flex-col">
      <PanelHeader className="flex items-center gap-2">
        <Play size={14} className="text-text-tertiary" />
        <PanelTitle>Recent runs</PanelTitle>
      </PanelHeader>
      <PanelBody className="flex-1 p-4">
        <div className="flex flex-col gap-3">
          {["sk-1", "sk-2", "sk-3", "sk-4", "sk-5"].map((id) => (
            <Skeleton key={id} className="h-10 w-full" />
          ))}
        </div>
      </PanelBody>
    </Panel>
  );
}
