import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { BroadcastIcon } from "@phosphor-icons/react/Broadcast";
import { FingerprintIcon } from "@phosphor-icons/react/Fingerprint";
import { Function } from "@phosphor-icons/react/Function";
import { GlobeIcon } from "@phosphor-icons/react/Globe";
import { KeyIcon } from "@phosphor-icons/react/Key";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { WebhooksLogoIcon } from "@phosphor-icons/react/WebhooksLogo";
import { formatDate, formatDuration } from "lib/format";
import { DebugSection } from "./debug-section";
import { ScenarioStatusBadge, SnapshotStatusBadge } from "./status-badges";
import type { ScenarioInstanceDebug, SnapshotDebug, WebhookCallDebug } from "./types";
import { WebhookCallCard } from "./webhook-call-card";

function formatTimestamp(value: string | undefined): string {
  if (value == null) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return formatDate(d);
}

interface EnvironmentSectionProps {
  deploymentUrl?: string;
  scenarioName?: string;
  snapshot?: SnapshotDebug;
}

export function EnvironmentSection({ deploymentUrl, scenarioName, snapshot }: EnvironmentSectionProps) {
  return (
    <DebugSection icon={<GlobeIcon size={12} className="text-text-tertiary" />} title="Environment">
      <div className="space-y-2">
        {deploymentUrl != null && (
          <div className="flex items-center gap-2">
            <span className="font-mono text-3xs text-text-tertiary">URL</span>
            <a
              href={deploymentUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex min-w-0 items-center gap-1 truncate font-mono text-xs text-primary-ink hover:underline"
            >
              <span className="truncate">{deploymentUrl}</span>
              <ArrowSquareOutIcon size={10} className="shrink-0" />
            </a>
          </div>
        )}
        {scenarioName != null && (
          <div className="flex items-center gap-2">
            <span className="font-mono text-3xs text-text-tertiary">Scenario</span>
            <span className="font-mono text-xs text-text-secondary">{scenarioName}</span>
          </div>
        )}
        {snapshot != null && (
          <div className="flex items-center gap-2">
            <span className="font-mono text-3xs text-text-tertiary">Snapshot</span>
            <span className="font-mono text-xs text-text-secondary">{snapshot.branchName}</span>
            <SnapshotStatusBadge status={snapshot.status} />
          </div>
        )}
      </div>
    </DebugSection>
  );
}

interface AuthenticationSectionProps {
  auth: NonNullable<ScenarioInstanceDebug["auth"]>;
}

export function AuthenticationSection({ auth }: AuthenticationSectionProps) {
  if (auth.cookieNames.length === 0 && auth.headerKeys.length === 0) return null;
  return (
    <DebugSection icon={<KeyIcon size={12} className="text-text-tertiary" />} title="Authentication">
      <div className="space-y-3">
        {auth.cookieNames.length > 0 && (
          <div>
            <span className="flex items-center gap-1.5 font-mono text-3xs text-text-tertiary">
              <FingerprintIcon size={10} />
              Cookies ({auth.cookieNames.length})
            </span>
            <NameList names={auth.cookieNames} />
          </div>
        )}
        {auth.headerKeys.length > 0 && (
          <div>
            <span className="flex items-center gap-1.5 font-mono text-3xs text-text-tertiary">
              Headers ({auth.headerKeys.length})
            </span>
            <NameList names={auth.headerKeys} />
          </div>
        )}
      </div>
    </DebugSection>
  );
}

function NameList({ names }: { names: string[] }) {
  return (
    <div className="mt-1 space-y-0.5">
      {names.map((name) => (
        <div key={name} className="flex items-center gap-2 rounded bg-surface-base px-2 py-1">
          <span className="font-mono text-xs text-text-secondary">{name}</span>
        </div>
      ))}
    </div>
  );
}

export function VariablesSection({ variables }: { variables: Record<string, unknown> }) {
  if (Object.keys(variables).length === 0) return null;
  return (
    <DebugSection icon={<Function size={12} className="text-text-tertiary" />} title="Variables">
      <div className="space-y-1">
        {Object.entries(variables).map(([key, value]) => (
          <div key={key} className="flex items-start gap-2 rounded bg-surface-base px-2 py-1">
            <span className="shrink-0 font-mono text-3xs text-text-tertiary">{key}</span>
            <span className="font-mono text-xs text-text-secondary">
              {typeof value === "object" && value != null ? JSON.stringify(value) : String(value ?? "")}
            </span>
          </div>
        ))}
      </div>
    </DebugSection>
  );
}

export function ScenarioSetupSection({ instance }: { instance: ScenarioInstanceDebug }) {
  const duration =
    instance.upAt != null && instance.downAt != null
      ? new Date(instance.downAt).getTime() - new Date(instance.upAt).getTime()
      : undefined;
  return (
    <DebugSection
      icon={<BroadcastIcon size={12} className="text-text-tertiary" />}
      title="Scenario Setup"
      badge={<ScenarioStatusBadge status={instance.status} />}
    >
      <div className="space-y-2">
        <Row label="Up" value={formatTimestamp(instance.upAt)} />
        {instance.downAt != null && <Row label="Down" value={formatTimestamp(instance.downAt)} />}
        {duration != null && <Row label="Duration" value={formatDuration(duration)} />}
        {instance.lastError != null && (
          <div className="flex items-start gap-2 rounded border border-status-critical/20 bg-status-critical/5 px-2 py-1.5">
            <WarningIcon size={12} className="shrink-0 text-status-critical" />
            <span className="font-mono text-3xs text-status-critical">{instance.lastError.message}</span>
          </div>
        )}
      </div>
    </DebugSection>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-3xs text-text-tertiary">{label}</span>
      <span className="font-mono text-xs text-text-secondary">{value}</span>
    </div>
  );
}

export function WebhookCallsSection({ calls }: { calls: WebhookCallDebug[] }) {
  if (calls.length === 0) return null;
  return (
    <DebugSection
      icon={<WebhooksLogoIcon size={12} className="text-text-tertiary" />}
      title={`Webhook Calls (${calls.length})`}
    >
      <div className="space-y-2">
        {calls.map((call) => (
          <WebhookCallCard
            key={call.id}
            action={call.action}
            statusCode={call.statusCode}
            durationMs={call.durationMs}
            error={call.error}
            createdAt={call.createdAt}
            requestBody={call.requestBody}
            responseBody={call.responseBody}
          />
        ))}
      </div>
    </DebugSection>
  );
}

export function ConversationSection({ url }: { url: string }) {
  return (
    <DebugSection icon={<ArrowSquareOutIcon size={12} className="text-text-tertiary" />} title="Conversation">
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1.5 font-mono text-xs text-primary-ink hover:underline"
      >
        View conversation JSON
        <ArrowSquareOutIcon size={10} />
      </a>
    </DebugSection>
  );
}
