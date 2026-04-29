import { Panel, PanelBody, PanelHeader, PanelTitle, Skeleton } from "@autonoma/blacklight";
import { GitCommitIcon } from "@phosphor-icons/react/GitCommit";
import { formatRelativeTime } from "lib/format";
import { usePullRequestCommits } from "lib/query/github.queries";

export function PRCommitsTab({ applicationId, prNumber }: { applicationId: string; prNumber: number }) {
  const { data: commits, isPending, isError } = usePullRequestCommits(applicationId, prNumber);

  return (
    <Panel>
      <PanelHeader className="flex items-center gap-2">
        <GitCommitIcon size={14} className="text-text-tertiary" />
        <PanelTitle>Commits</PanelTitle>
        {commits != null && (
          <span className="ml-auto font-mono text-2xs text-text-tertiary">{commits.length} total</span>
        )}
      </PanelHeader>
      <PanelBody className="p-0">
        {isPending && <CommitsSkeleton />}
        {isError && <div className="p-5 text-sm text-text-tertiary">Failed to load commits from GitHub.</div>}
        {commits != null && commits.length === 0 && (
          <div className="p-5 text-sm text-text-tertiary">No commits on this PR yet.</div>
        )}
        {commits != null && commits.length > 0 && (
          <ul>
            {commits.map((commit) => (
              <CommitRow key={commit.sha} commit={commit} />
            ))}
          </ul>
        )}
      </PanelBody>
    </Panel>
  );
}

interface Commit {
  sha: string;
  message: string;
  authorLogin?: string;
  authoredAt: string;
}

function CommitRow({ commit }: { commit: Commit }) {
  const firstLine = commit.message.split("\n")[0] ?? "";
  const authoredAt = commit.authoredAt.length > 0 ? new Date(commit.authoredAt) : undefined;

  return (
    <li className="flex items-center gap-4 border-b border-border-dim px-5 py-3 last:border-b-0">
      <GitCommitIcon size={14} className="shrink-0 text-text-tertiary" />
      <p className="min-w-0 flex-1 truncate text-sm text-text-primary">{firstLine}</p>
      <div className="flex shrink-0 items-center gap-3 font-mono text-2xs text-text-tertiary">
        <code className="border border-border-dim bg-surface-raised px-1.5 py-0.5 text-text-secondary">
          {commit.sha.slice(0, 7)}
        </code>
        {commit.authorLogin != null && <span>{commit.authorLogin}</span>}
        {authoredAt != null && <span>· {formatRelativeTime(authoredAt)}</span>}
      </div>
    </li>
  );
}

function CommitsSkeleton() {
  return (
    <div className="flex flex-col gap-3 p-5">
      {["sk-1", "sk-2", "sk-3"].map((id) => (
        <Skeleton key={id} className="h-10 w-full" />
      ))}
    </div>
  );
}
