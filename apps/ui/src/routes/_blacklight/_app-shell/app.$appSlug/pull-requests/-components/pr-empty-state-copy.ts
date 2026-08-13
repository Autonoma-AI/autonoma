import type { PullRequestStateFilter } from "lib/query/branches.queries";

/**
 * What an empty tab says. Kept together so the three cannot drift, and so the advice is only given where there
 * is something to act on - telling someone looking at the Closed tab to push a branch would be noise.
 */
export const PR_EMPTY_DESCRIPTION: Record<PullRequestStateFilter, string> = {
    open: "Push a branch with an open PR to see it tracked here.",
    merged: "Pull requests appear here once they are merged, with the checkpoint they were merged on.",
    closed: "Pull requests closed without merging end up here, alongside whatever the agent found on them.",
};
