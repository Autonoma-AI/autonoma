import type { PullRequestStateFilter } from "lib/query/branches.queries";

/**
 * The EMPTY readings: this repository has had pull requests and this tab has none right now. The zero reading -
 * nothing has ever happened here - is the vigil body, which names what starts a run rather than reporting a count.
 */
export const PR_EMPTY_DESCRIPTION: Record<PullRequestStateFilter, string> = {
    open: "Autonoma reviews a pull request once it is opened and not a draft. Nothing is open right now.",
    merged: "Pull requests appear here once they are merged, with the checkpoint they were merged on.",
    closed: "Pull requests closed without merging end up here, alongside whatever the agent found on them.",
};
