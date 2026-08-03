import { Badge, Skeleton } from "@autonoma/blacklight";
import type { MainOpenProblem, MainProblemSource } from "@autonoma/types";
import { analysisIssueKindMeta, analysisIssueSeverityMeta } from "components/analysis/issue-meta";
import { MainProblemLink } from "components/main-problems/main-problem-link";
import { formatRelativeTime } from "lib/format";
import { useMainOpenProblems } from "lib/query/branches.queries";

/**
 * The main-branch page's problem list: everything still unresolved on main, ordered bugs-first then by descending
 * severity. It renders unconditionally - including its empty state - because the checkpoint badges beside it are
 * always shown, and a count with no list under it reads as data we are hiding.
 */
export function MainProblemsSection({ applicationId }: { applicationId: string }) {
  const { data } = useMainOpenProblems(applicationId);

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold text-text-primary">
        Open problems on main · <span className="font-mono text-text-secondary">{data.problems.length}</span>
      </h2>
      {data.problems.length === 0 ? (
        <p className="border border-border-dim bg-surface-void px-4 py-4 text-sm text-text-secondary">
          Nothing is unresolved on main.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {data.problems.map((problem) => (
            <ProblemRow key={problem.id} problem={problem} source={data.source} />
          ))}
        </div>
      )}
    </section>
  );
}

export function MainProblemsSectionSkeleton() {
  return (
    <section className="flex flex-col gap-2">
      <Skeleton className="h-5 w-48" />
      <div className="flex flex-col gap-2">
        {["sk-1", "sk-2"].map((id) => (
          <Skeleton key={id} className="h-16 w-full" />
        ))}
      </div>
    </section>
  );
}

function ProblemRow({ problem, source }: { problem: MainOpenProblem; source: MainProblemSource }) {
  const kindMeta = analysisIssueKindMeta(problem.kind);
  const severityMeta = analysisIssueSeverityMeta(problem.severity);

  return (
    <MainProblemLink
      problemId={problem.id}
      source={source}
      className="flex flex-col gap-1 border border-border-dim bg-surface-void px-4 py-3 transition-colors hover:border-border-mid hover:bg-surface-raised"
    >
      <div className="flex min-w-0 items-center gap-2">
        <Badge variant={severityMeta.variant}>{severityMeta.label}</Badge>
        {problem.kind !== "bug" && (
          <Badge variant={kindMeta.variant} className="font-mono uppercase">
            {kindMeta.label}
          </Badge>
        )}
        <span className="truncate text-sm font-medium text-text-primary">{problem.title}</span>
        <span className="ml-auto shrink-0 font-mono text-2xs text-text-secondary">
          last seen {formatRelativeTime(problem.lastSeenAt)}
        </span>
      </div>
      {problem.detail != null && (
        <p className="line-clamp-2 text-sm leading-relaxed text-text-secondary">{problem.detail}</p>
      )}
    </MainProblemLink>
  );
}
