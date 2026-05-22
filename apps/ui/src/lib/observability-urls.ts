/**
 * Pure URL builders for "View in {tool}" deep links shown next to admin-only
 * workflow details. One place to bump constants (Sentry project IDs, default
 * stats period) when they change.
 */

const SENTRY_PROJECT_IDS = ["29", "25", "31"] as const;
const SENTRY_STATS_PERIOD = "7d";
const SENTRY_ORGANIZATION = "agent";

export interface TemporalUrlParams {
    baseUrl: string;
    namespace: string;
    workflowId: string;
    runId?: string;
}

export function buildTemporalWorkflowUrl({ baseUrl, namespace, workflowId, runId }: TemporalUrlParams): string {
    const trimmedBase = baseUrl.replace(/\/+$/, "");
    const path = `/namespaces/${encodeURIComponent(namespace)}/workflows/${encodeURIComponent(workflowId)}`;
    if (runId == null || runId === "") return `${trimmedBase}${path}`;
    return `${trimmedBase}${path}/${encodeURIComponent(runId)}`;
}

export interface SentryLogsUrlParams {
    baseUrl: string;
    environment: string;
    /**
     * Canonical observability field to filter by (snapshotId / runId /
     * testGenerationId / etc). Picking the entity's natural ID instead of
     * `workflowId` catches the full causal chain - parent + child workflows
     * + activities + jobs that share that ID via ALS.
     */
    filterField: string;
    filterValue: string;
}

export function buildSentryLogsUrl({ baseUrl, environment, filterField, filterValue }: SentryLogsUrlParams): string {
    const trimmedBase = baseUrl.replace(/\/+$/, "");
    const params = new URLSearchParams();
    params.set("environment", environment);
    params.append("logsFields", "timestamp");
    params.append("logsFields", "message");
    params.set("logsQuery", `${filterField}:${filterValue}`);
    params.set("logsSortBys", "-timestamp");
    for (const project of SENTRY_PROJECT_IDS) params.append("project", project);
    params.set("statsPeriod", SENTRY_STATS_PERIOD);
    return `${trimmedBase}/organizations/${SENTRY_ORGANIZATION}/explore/logs/?${params.toString()}`;
}
