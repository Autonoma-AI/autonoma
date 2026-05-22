import { Button } from "@autonoma/blacklight";
import { Sentry as SentryIcon } from "components/icons/sentry";
import { Temporal as TemporalIcon } from "components/icons/temporal";
import { env } from "env";
import { buildSentryLogsUrl, buildTemporalWorkflowUrl } from "lib/observability-urls";
import { useAdminDeploymentConfig } from "lib/query/admin.queries";
import { Suspense } from "react";

interface TemporalLinkProps {
  workflowId: string;
  runId?: string;
}

/**
 * Admin "View in Temporal" deep link. Renders only when VITE_TEMPORAL_URL is
 * set (skipped on local dev). Callers are expected to gate on isAdmin.
 */
export function TemporalLink({ workflowId, runId }: TemporalLinkProps) {
  if (env.VITE_TEMPORAL_URL == null) return null;
  const url = buildTemporalWorkflowUrl({
    baseUrl: env.VITE_TEMPORAL_URL,
    namespace: env.VITE_TEMPORAL_NAMESPACE,
    workflowId,
    runId,
  });
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" aria-label="View workflow in Temporal">
      <Button variant="outline" size="sm" className="size-7 p-0">
        <TemporalIcon className="size-4" />
      </Button>
    </a>
  );
}

interface SentryLogsLinkProps {
  /**
   * Canonical observability field to filter on (snapshotId / runId /
   * testGenerationId / ...). Pick the page's natural entity ID so the
   * resulting query catches the full causal chain across parent and child
   * workflows, not just one workflowId.
   */
  filterField: string;
  filterValue: string;
}

/**
 * Admin "View Sentry logs" deep link, filtered by a canonical entity ID.
 * Renders only when VITE_SENTRY_URL is set and the backend reports a
 * SENTRY_ENV. Callers are expected to gate on isAdmin.
 */
export function SentryLogsLink({ filterField, filterValue }: SentryLogsLinkProps) {
  if (env.VITE_SENTRY_URL == null) return null;
  return (
    <Suspense fallback={null}>
      <SentryLogsLinkInner sentryBaseUrl={env.VITE_SENTRY_URL} filterField={filterField} filterValue={filterValue} />
    </Suspense>
  );
}

function SentryLogsLinkInner({
  sentryBaseUrl,
  filterField,
  filterValue,
}: {
  sentryBaseUrl: string;
  filterField: string;
  filterValue: string;
}) {
  const { data } = useAdminDeploymentConfig();
  if (data.environment == null) return null;
  const url = buildSentryLogsUrl({
    baseUrl: sentryBaseUrl,
    environment: data.environment,
    filterField,
    filterValue,
  });
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" aria-label={`View Sentry logs filtered by ${filterField}`}>
      <Button variant="outline" size="sm" className="size-7 p-0">
        <SentryIcon className="size-4" />
      </Button>
    </a>
  );
}
