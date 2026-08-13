/** Whether a checked-out repo is the application's primary repo or a pinned dependency. */
export type RepoRole = "primary" | "dependency";

/**
 * One repository checked out within a workspace. The agent references a repo by
 * its {@link name} (the value it puts in an evidence/codeReference `repo`), reads
 * it through the `bash` tool relative to {@link relPath} (the path from the
 * workspace root, which is the bash working directory), and - when a
 * {@link baseSha} exists - inspects what changed with
 * `git -C <relPath> diff <baseSha>..<headSha>`.
 */
export interface RepoCheckout {
    /** The lowercased `owner/repo` full name - the same identity the dependency pin is keyed by. Unique per workspace. */
    name: string;
    role: RepoRole;
    /**
     * Path to this repo relative to the workspace root (the bash working
     * directory). `"."` for a flat single-repo checkout (the root *is* the repo);
     * a sibling directory name in a multi-repo workspace.
     */
    relPath: string;
    /** Absolute path to this repo's clone on disk. */
    dir: string;
    /** Commit this repo is checked out at (the primary's head, or a dependency's pinned deployed sha). */
    headSha: string;
    /**
     * The diff base, when one exists: the snapshot's base SHA for the primary,
     * or the same dependency's pinned sha on the previous snapshot for a
     * dependency. Absent => read-only, no diff (first snapshot / newly-added dep).
     */
    baseSha?: string;
}

/**
 * A dependency that was pinned but could not be checked out (its key was not a
 * resolvable `owner/repo`, or the clone failed). Named in the prompt so the agent
 * grounds only against present code rather than guessing at code it can't read.
 */
export interface UnavailableRepo {
    name: string;
    reason: string;
}

/**
 * The multi-repo layout the agent works across: the primary repo plus every
 * dependency checked out beside it, and the dependencies that could not be. Only
 * present when a snapshot pinned at least one resolvable dependency; a plain
 * single-repo checkout has no manifest (the agent works in one repo at the bash
 * working directory, exactly as before multi-repo grounding).
 */
export interface RepoManifest {
    /** The bash working directory: the parent that holds every repo as a sibling. */
    workspaceRoot: string;
    primary: RepoCheckout;
    dependencies: RepoCheckout[];
    unavailable: UnavailableRepo[];
}
