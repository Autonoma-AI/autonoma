import { Skeleton, ZeroState, cn } from "@autonoma/blacklight";
import type { MainOpenProblem } from "@autonoma/types";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { formatRelativeTime } from "lib/format";
import { useApplicationActivity } from "lib/query/activity.queries";
import { useMainOpenProblems } from "lib/query/branches.queries";
import { SURFACE_COPY } from "lib/zero-state/copy";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";
import { useCurrentApplication } from "routes/_blacklight/_app-shell/-use-current-application";

type RailHeader = { kind: "loading" } | { kind: "never_run" } | { kind: "checked"; count: number };

interface RailHeaderCopy {
  /**
   * What draws the skeleton is the loading reading itself, never the absence of a string. Keyed the other way, a
   * reading with nothing to say here would render a skeleton that never resolves.
   */
  label?: string;
  description?: string;
  critical: boolean;
}

/**
 * A red "● Unresolved on main · 0" asserts a check was performed and came back clean, which is false on an
 * application that has never run one and while the count is still in flight. So the critical tone and the number
 * appear together or not at all.
 */
function railHeaderCopy(header: RailHeader): RailHeaderCopy {
  if (header.kind === "checked") {
    return {
      label: "Unresolved on main",
      description: "Open problems the agent has flagged on your main branch, most severe first.",
      critical: true,
    };
  }
  if (header.kind === "never_run") {
    return { label: "Main branch", critical: false };
  }
  return { critical: false };
}

/**
 * `self-start max-h-full` is what keeps this a card beside the table rather than a column down the side of the
 * window: as a plain flex child it stretches to the row's height. The inner region keeps its own scroll for when
 * the problems outrun the cap.
 */
function RailShell({ header, children }: { header: RailHeader; children: React.ReactNode }) {
  const { label, description, critical } = railHeaderCopy(header);
  const isLoading = header.kind === "loading";

  return (
    <aside className="flex max-h-full w-85 shrink-0 flex-col self-start overflow-hidden border border-border-dim bg-surface-base">
      <div className="shrink-0 border-b border-border-dim px-4 py-3.5">
        <div className="flex items-center gap-2">
          {isLoading ? (
            <Skeleton className="h-2.5 w-32" />
          ) : (
            // A heading, not a styled span: this is the `aside` landmark's title, so a screen reader can name
            // the region. Preflight strips a heading's margin and size, so it renders the same.
            <h2
              className={cn(
                "font-mono text-3xs font-semibold uppercase tracking-widest",
                critical ? "text-status-critical" : "text-text-secondary",
              )}
            >
              ● {label}
            </h2>
          )}
          {header.kind === "checked" && (
            <span className="font-mono text-2xs text-text-secondary">· {header.count}</span>
          )}
        </div>
        {isLoading ? (
          <Skeleton className="mt-2 h-2.5 w-4/5" />
        ) : description != null ? (
          <p className="mt-1.5 text-2xs leading-snug text-text-secondary">{description}</p>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>

      <AppLink
        to="/app/$appSlug/pull-requests/main"
        className="flex shrink-0 items-center justify-between border-t border-border-dim px-4 py-3.5 font-mono text-3xs uppercase tracking-widest text-text-secondary transition-colors hover:text-text-primary"
      >
        Main branch
        <ArrowRightIcon size={11} weight="bold" />
      </AppLink>
    </aside>
  );
}

export function MainProblemsRail() {
  const app = useCurrentApplication();
  const { data: problems } = useMainOpenProblems(app.id);
  const { hasEverRun } = useApplicationActivity();

  if (!hasEverRun) {
    const { title, description } = SURFACE_COPY.main_problems_rail.zero;
    return (
      <RailShell header={{ kind: "never_run" }}>
        <ZeroState variant="bare" title={title} description={description} />
      </RailShell>
    );
  }

  return (
    <RailShell header={{ kind: "checked", count: problems.length }}>
      {problems.length === 0 ? (
        <div className="px-4 py-10 text-center font-mono text-3xs uppercase tracking-widest text-text-secondary">
          {SURFACE_COPY.main_problems_rail.empty.title}
        </div>
      ) : (
        problems.map((problem) => <ProblemRow key={problem.id} problem={problem} />)
      )}
    </RailShell>
  );
}

function ProblemRow({ problem }: { problem: MainOpenProblem }) {
  return (
    <AppLink
      to="/app/$appSlug/analysis/issues/$issueId"
      params={{ issueId: problem.id }}
      className="flex flex-col gap-1 border-b border-border-dim px-4 py-3 transition-colors hover:bg-surface-raised"
    >
      <span className="text-xs font-medium leading-snug text-text-primary">{problem.title}</span>
      <span className="font-mono text-3xs text-text-secondary">{problemMeta(problem)}</span>
    </AppLink>
  );
}

/** The kind is named only when it is not a bug, so an environment problem is never read as a claim about the app. */
function problemMeta(problem: MainOpenProblem): string {
  const parts: string[] = [];
  if (problem.occurrences > 0) parts.push(`×${problem.occurrences}`);
  if (problem.kind !== "bug") parts.push(problem.kind);
  parts.push(problem.severity);
  parts.push(`last seen ${formatRelativeTime(problem.lastSeenAt)}`);
  return parts.join(" · ");
}

export function MainProblemsRailSkeleton() {
  return (
    <RailShell header={{ kind: "loading" }}>
      {["sk-1", "sk-2", "sk-3"].map((id) => (
        <div key={id} className="flex flex-col gap-1.5 border-b border-border-dim px-4 py-3">
          <Skeleton className="h-3 w-4/5" />
          <Skeleton className="h-2.5 w-2/5" />
        </div>
      ))}
    </RailShell>
  );
}
