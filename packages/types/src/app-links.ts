/**
 * The one place that knows the in-app URL shapes for a pull request's analysis surfaces.
 *
 * These paths are built outside the UI by more than one caller - the GitHub PR comment (from the diffs worker) and
 * the MCP tools (from the API) - and a reader who follows a link from either must land on the same page. Keeping the
 * shapes here means a route rename is one edit, not a hunt across two apps whose stale copy would 404 silently.
 *
 * `appBaseUrl` is the caller's own origin (the API reads `APP_URL`; the worker derives it from its deploy env), so
 * this module stays free of environment knowledge.
 */

/** The PR overview page - the "Open in Autonoma" destination for a run. */
export function buildPrPageUrl(appBaseUrl: string, appSlug: string, prNumber: number): string {
    return absolute(appBaseUrl, `/app/${encodeURIComponent(appSlug)}/pull-requests/${prNumber}/`);
}

/**
 * One issue's detail page. Issues are branch-scoped (they evolve across snapshots), so the route sits at the PR
 * level, above snapshots - a link stays valid after the next push, unlike a per-snapshot finding link.
 */
export function buildAnalysisIssueUrl(appBaseUrl: string, appSlug: string, prNumber: number, issueId: string): string {
    const path = `/app/${encodeURIComponent(appSlug)}/pull-requests/${prNumber}/issues/${encodeURIComponent(issueId)}`;
    return absolute(appBaseUrl, path);
}

/**
 * One finding's detail page inside a specific snapshot - the run that reproduces an issue. Use this for "watch the
 * replay"; use {@link buildAnalysisIssueUrl} for the issue itself.
 */
export function buildAnalysisFindingUrl(
    appBaseUrl: string,
    appSlug: string,
    prNumber: number,
    snapshotId: string,
    findingId: string,
): string {
    const base = `/app/${encodeURIComponent(appSlug)}/pull-requests/${prNumber}/snapshots`;
    const path = `${base}/${encodeURIComponent(snapshotId)}/findings/${encodeURIComponent(findingId)}`;
    return absolute(appBaseUrl, path);
}

function absolute(appBaseUrl: string, path: string): string {
    return new URL(path, appBaseUrl).toString();
}
