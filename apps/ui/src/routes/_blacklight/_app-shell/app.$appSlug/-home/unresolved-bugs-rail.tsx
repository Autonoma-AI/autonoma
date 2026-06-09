import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { formatRelativeTime } from "lib/format";
import { useBugs } from "lib/query/bugs.queries";
import type { RouterOutputs } from "lib/trpc";
import { AppLink } from "../../-app-link";

type Bug = RouterOutputs["bugs"]["list"][number];

const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function RailShell({ count, children }: { count: number; children: React.ReactNode }) {
  return (
    <aside className="flex w-[340px] shrink-0 flex-col overflow-hidden border-l border-border-dim bg-surface-base">
      <div className="shrink-0 border-b border-border-dim px-4 py-3.5">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-status-critical">
            ● Unresolved on main
          </span>
          <span className="font-mono text-[11px] text-text-tertiary">· {count}</span>
        </div>
        <p className="mt-1.5 text-[11px] leading-[1.45] text-text-tertiary">
          Open bugs the agent has flagged on your main branch, most severe first.
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>

      <AppLink
        to="/app/$appSlug/pull-requests/main"
        className="flex shrink-0 items-center justify-between border-t border-border-dim px-4 py-3.5 font-mono text-[10px] uppercase tracking-[0.08em] text-text-tertiary transition-colors hover:text-text-primary"
      >
        Main branch
        <ArrowRightIcon size={11} weight="bold" />
      </AppLink>
    </aside>
  );
}

export function UnresolvedBugsRail() {
  const { data: bugs } = useBugs("open");
  const sorted = [...bugs].sort((a, b) => (SEVERITY_RANK[a.severity] ?? 99) - (SEVERITY_RANK[b.severity] ?? 99));

  return (
    <RailShell count={sorted.length}>
      {sorted.length === 0 ? (
        <div className="px-4 py-10 text-center font-mono text-[10px] uppercase tracking-[0.1em] text-text-tertiary">
          No unresolved bugs
        </div>
      ) : (
        sorted.map((bug) => <BugRow key={bug.id} bug={bug} />)
      )}
    </RailShell>
  );
}

function BugRow({ bug }: { bug: Bug }) {
  return (
    <AppLink
      to="/app/$appSlug/bugs/$bugId"
      params={{ bugId: bug.id }}
      className="flex flex-col gap-1 border-b border-border-dim px-4 py-3 transition-colors hover:bg-surface-raised"
    >
      <span className="text-[12px] font-medium leading-[1.35] text-text-primary">{bug.title}</span>
      <span className="font-mono text-[10px] text-text-tertiary">
        ×{bug.occurrences} · {bug.severity} · last seen {formatRelativeTime(bug.lastSeenAt)}
      </span>
    </AppLink>
  );
}

export function UnresolvedBugsRailSkeleton() {
  return (
    <RailShell count={0}>
      {["sk-1", "sk-2", "sk-3"].map((id) => (
        <div key={id} className="flex flex-col gap-1.5 border-b border-border-dim px-4 py-3">
          <div className="h-3 w-4/5 animate-pulse bg-surface-raised" />
          <div className="h-2.5 w-2/5 animate-pulse bg-surface-raised" />
        </div>
      ))}
    </RailShell>
  );
}
