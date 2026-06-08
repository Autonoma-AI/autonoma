import { DetailRow } from "components/detail-row";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";

export interface PullRequestRef {
  number: number;
  snapshotId: string;
  snapshotSha?: string;
}

/**
 * Sidebar rows linking a run or generation to the pull request and branch snapshot it was part of.
 * Only rendered when the underlying snapshot belongs to a PR (the snapshot report page is nested under
 * the PR route, so both links require a PR number).
 */
export function PullRequestDetailRows({ pullRequest }: { pullRequest: PullRequestRef }) {
  return (
    <div className="grid grid-cols-2 gap-4">
      <DetailRow label="Pull request">
        <AppLink
          to="/app/$appSlug/pull-requests/$prNumber"
          params={{ prNumber: pullRequest.number }}
          className="inline-flex items-center gap-1 font-medium text-primary-ink hover:underline"
        >
          #{pullRequest.number}
        </AppLink>
      </DetailRow>

      <DetailRow label="Checkpoint">
        <AppLink
          to="/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId"
          params={{ prNumber: pullRequest.number, snapshotId: pullRequest.snapshotId }}
          className="inline-flex items-center gap-1 font-mono text-xs text-primary-ink hover:underline"
        >
          {pullRequest.snapshotSha?.slice(0, 7) ?? "View checkpoint"}
        </AppLink>
      </DetailRow>
    </div>
  );
}
