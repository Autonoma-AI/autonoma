import { Skeleton } from "@autonoma/blacklight";
import type { MainOpenProblem } from "@autonoma/types";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { formatRelativeTime } from "lib/format";
import { useMainOpenProblems } from "lib/query/branches.queries";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";
import { useCurrentApplication } from "routes/_blacklight/_app-shell/-use-current-application";

/**
 * `self-start max-h-full` is what makes this a card beside the table rather than a column down the side of the
 * window. As a plain flex child it stretched to the row, so on an application with nothing unresolved the header
 * and its one-line "no unresolved problems" sat at the top with a screen of empty surface below them and the
 * main-branch link stranded at the very bottom - all while the pull request panel beside it, which sizes to its
 * rows, ended a few hundred pixels higher. Starting at the top and capping at the row's height gives both
 * columns the same rule: grow to what you have, stop at what fits. The inner region keeps its own scroll for
 * the case where the problems outrun the cap.
 *
 * A full border rather than the left edge alone, now that it ends where its content does - a lone rule floating
 * beside the table read as a seam that had come apart.
 */
function RailShell({ count, children }: { count: number; children: React.ReactNode }) {
  return (
    <aside className="flex max-h-full w-85 shrink-0 flex-col self-start overflow-hidden border border-border-dim bg-surface-base">
      <div className="shrink-0 border-b border-border-dim px-4 py-3.5">
        <div className="flex items-center gap-2">
          <span className="font-mono text-3xs font-semibold uppercase tracking-widest text-status-critical">
            ● Unresolved on main
          </span>
          <span className="font-mono text-2xs text-text-secondary">· {count}</span>
        </div>
        <p className="mt-1.5 text-2xs leading-snug text-text-secondary">
          Open problems the agent has flagged on your main branch, most severe first.
        </p>
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

  return (
    <RailShell count={problems.length}>
      {problems.length === 0 ? (
        <div className="px-4 py-10 text-center font-mono text-3xs uppercase tracking-widest text-text-secondary">
          No unresolved problems
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

/**
 * The row's one-line provenance. The kind is named only when it is not a bug, so an environment or scenario problem
 * is never read as a claim about the application.
 */
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
    <RailShell count={0}>
      {["sk-1", "sk-2", "sk-3"].map((id) => (
        <div key={id} className="flex flex-col gap-1.5 border-b border-border-dim px-4 py-3">
          <Skeleton className="h-3 w-4/5" />
          <Skeleton className="h-2.5 w-2/5" />
        </div>
      ))}
    </RailShell>
  );
}
