import { formatRelativeTime } from "lib/format";
import type { PullRequestRow } from "./pull-request-row";

/**
 * When the pull request last moved, in words.
 *
 * `prUpdatedAt` is cached from GitHub and is the field the server sorts the list by, so it is the honest answer
 * whenever it is there. Until the cache catches up it is absent, and a dash in its place says "we know nothing
 * about this PR" when we do know when it was opened - so the label names which of the two it is showing rather
 * than quietly presenting one as the other.
 */
export function prActivityLabel(row: PullRequestRow): string {
    if (row.prUpdatedAt != null) return `updated ${formatRelativeTime(row.prUpdatedAt)}`;
    return `opened ${formatRelativeTime(row.createdAt)}`;
}
