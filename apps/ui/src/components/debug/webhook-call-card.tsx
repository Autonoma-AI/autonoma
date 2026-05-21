import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { XCircleIcon } from "@phosphor-icons/react/XCircle";
import { formatDate, formatDuration } from "lib/format";
import { JsonPreview } from "./json-preview";
import { toActionColor, toActionLabel } from "./webhook-action";

interface WebhookCallCardProps {
  action: string;
  statusCode?: number;
  durationMs?: number;
  error?: string;
  createdAt: string;
  requestBody: unknown;
  responseBody: unknown;
}

function StatusBadge({ statusCode, error }: { statusCode?: number; error?: string }) {
  if (error != null) {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-status-critical/10 px-1.5 py-0.5 font-mono text-3xs text-status-critical">
        <XCircleIcon size={10} weight="fill" />
        Error
      </span>
    );
  }
  if (statusCode == null) {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-text-tertiary/10 px-1.5 py-0.5 font-mono text-3xs text-text-tertiary">
        No response
      </span>
    );
  }
  if (statusCode >= 200 && statusCode < 300) {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-status-success/10 px-1.5 py-0.5 font-mono text-3xs text-status-success">
        <CheckCircleIcon size={10} weight="fill" />
        {statusCode}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded bg-status-warn/10 px-1.5 py-0.5 font-mono text-3xs text-status-warn">
      <WarningIcon size={10} weight="fill" />
      {statusCode}
    </span>
  );
}

export function WebhookCallCard({
  action,
  statusCode,
  durationMs,
  error,
  createdAt,
  requestBody,
  responseBody,
}: WebhookCallCardProps) {
  return (
    <div className="rounded border border-border-dim bg-surface-raised p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className={`font-mono text-xs font-medium ${toActionColor(action)}`}>{toActionLabel(action)}</span>
          <StatusBadge statusCode={statusCode} error={error} />
        </div>
        <div className="flex items-center gap-3 font-mono text-3xs text-text-tertiary">
          <span>{formatDuration(durationMs)}</span>
          <span>{formatDate(new Date(createdAt))}</span>
        </div>
      </div>

      {error != null && (
        <div className="mt-2 rounded border border-status-critical/20 bg-status-critical/5 px-2 py-1.5">
          <p className="font-mono text-3xs text-status-critical">{error}</p>
        </div>
      )}

      <JsonPreview data={requestBody} label="Request body" />
      <JsonPreview data={responseBody} label="Response body" />
    </div>
  );
}
