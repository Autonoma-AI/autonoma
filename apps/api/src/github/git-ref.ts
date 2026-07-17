/** Strips a leading `refs/heads/` and surrounding whitespace from a branch ref. */
export function normalizeBranchName(ref: string): string {
    const trimmed = ref.trim();
    return trimmed.startsWith("refs/heads/") ? trimmed.slice("refs/heads/".length) : trimmed;
}

/** The HTTP status carried by an Octokit request error (404 = repo/branch not visible to the installation), if any. */
export function githubErrorStatus(error: unknown): number | undefined {
    if (error instanceof Error && "status" in error) {
        const status: unknown = error.status;
        return typeof status === "number" ? status : undefined;
    }
    return undefined;
}

/** True when a GitHub client error carries a 404 status. */
export function isGithubNotFound(error: unknown): boolean {
    return githubErrorStatus(error) === 404;
}
