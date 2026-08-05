/**
 * Subject-scoped facts about the code change that triggered a review, gathered
 * entirely from the database by the `DiffJobContextLoader`. Used by the
 * generation reviewer - the change a reviewer must attribute against is the
 * same fact set regardless of which subject executed.
 *
 * Deliberately carries only what is DB-sourced and **not** reproducible from
 * git: the SHAs bound the diff, so the reviewer knows what to `git diff`
 * against. The raw changed-file list and the diff hunks are intentionally
 * absent - the reviewer derives them itself via `git diff <baseSha>..<headSha>`
 * in bash.
 */
export interface ChangeContext {
    /** Commit the change is measured against (the diff's "before"). */
    baseSha: string;
    /** Commit under test (the diff's "after"). */
    headSha: string;
}
