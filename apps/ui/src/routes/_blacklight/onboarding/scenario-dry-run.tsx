import { Button, cn } from "@autonoma/blacklight";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { FlaskIcon } from "@phosphor-icons/react/Flask";
import { PencilSimpleIcon } from "@phosphor-icons/react/PencilSimple";
import { PlayIcon } from "@phosphor-icons/react/Play";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  useCompleteOnboarding,
  useConfigureAndDiscoverScenarios,
  useOnboardingScenarios,
  useRunScenarioDryRun,
} from "lib/onboarding/onboarding-api";
import { useEffect, useRef, useState } from "react";
import { onboardingSearchSchema } from "./-onboarding-search";

export const Route = createFileRoute("/_blacklight/onboarding/scenario-dry-run")({
  component: ScenarioDryRunPage,
  validateSearch: onboardingSearchSchema,
});

interface DryRunResult {
  success: boolean;
  phase: "up" | "down";
  error: unknown;
}

interface LogEntry {
  id: string;
  timestamp: Date;
  type: "info" | "success" | "error";
  message: string;
}

function useLogEntries() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const nextId = useRef(0);

  function addEntry(type: LogEntry["type"], message: string) {
    const id = String(nextId.current++);
    setEntries((prev) => [...prev, { id, timestamp: new Date(), type, message }]);
  }

  function clear() {
    setEntries([]);
    nextId.current = 0;
  }

  return { entries, addEntry, clear };
}

function formatError(error: unknown): string {
  if (error == null) return "Unknown error";
  if (typeof error === "string") return error;
  if (typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return String(error);
}

function WebhookLog({ entries }: { entries: LogEntry[] }) {
  const consoleRef = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll triggered by entry count change
  useEffect(() => {
    if (consoleRef.current != null) {
      consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
    }
  }, [entries.length]);

  if (entries.length === 0) return null;

  return (
    <div className="mt-6 overflow-hidden border border-border-dim bg-surface-base">
      <div className="flex items-center justify-between border-b border-border-dim bg-surface-raised px-4 py-2">
        <span className="font-mono text-3xs uppercase tracking-widest text-text-tertiary">Webhook Log</span>
      </div>
      <div
        ref={consoleRef}
        className="max-h-56 overflow-y-auto p-4 font-mono text-sm"
        style={{ scrollBehavior: "smooth" }}
      >
        {entries.map((entry) => (
          <div key={entry.id} className="mb-1.5 flex items-start gap-3">
            <span className="mt-0.5 w-20 shrink-0 text-3xs text-text-tertiary opacity-50">
              {entry.timestamp.toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}
            </span>
            <span className="mt-0.5 flex size-3 shrink-0 items-center justify-center">
              {entry.type === "error" ? (
                <WarningCircleIcon size={12} className="text-status-critical" />
              ) : entry.type === "success" ? (
                <CheckCircleIcon size={12} className="text-status-success" />
              ) : null}
            </span>
            <span
              className={cn(
                "break-all text-2xs",
                entry.type === "error" && "text-status-critical",
                entry.type === "success" && "text-status-success",
                entry.type === "info" && "text-text-secondary",
              )}
            >
              {entry.message}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ScenarioDryRunPage() {
  const { appId: applicationId } = Route.useSearch();

  const [webhookUrl, setWebhookUrl] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const [customHeaders, setCustomHeaders] = useState<Array<{ key: string; value: string }>>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [selectedScenarioId, setSelectedScenarioId] = useState<string>();
  const [dryRunResult, setDryRunResult] = useState<DryRunResult>();
  const [isEditing, setIsEditing] = useState(false);

  const navigate = useNavigate();
  const discoverScenarios = useConfigureAndDiscoverScenarios();
  const scenariosQuery = useOnboardingScenarios(applicationId ?? "");
  const runDryRun = useRunScenarioDryRun();
  const completeOnboarding = useCompleteOnboarding();
  const log = useLogEntries();

  const scenarios = scenariosQuery.data ?? [];
  const isWebhookConfigured = scenarios.length > 0 && !isEditing;
  const effectiveScenarioId = selectedScenarioId ?? scenarios[0]?.id;
  const dryRunPassed = dryRunResult?.success === true;

  function handleDiscoverScenarios() {
    if (webhookUrl.length === 0 || signingSecret.length === 0) return;

    log.clear();
    log.addEntry("info", `Discovering scenarios at ${webhookUrl}...`);

    const headersRecord: Record<string, string> = {};
    for (const h of customHeaders) {
      if (h.key.length > 0) headersRecord[h.key] = h.value;
    }
    const webhookHeaders = Object.keys(headersRecord).length > 0 ? headersRecord : undefined;

    discoverScenarios.mutate(
      { applicationId, webhookUrl, signingSecret, webhookHeaders },
      {
        onSuccess: () => {
          log.addEntry("success", "Scenarios discovered successfully");
          setSelectedScenarioId(undefined);
          setDryRunResult(undefined);
          setIsEditing(false);
        },
        onError: (error) => {
          log.addEntry("error", formatError(error));
        },
      },
    );
  }

  function handleReconfigure() {
    setIsEditing(true);
    setDryRunResult(undefined);
    log.clear();
  }

  function handleRunDryRun() {
    if (effectiveScenarioId == null) return;

    const scenarioName = scenarios.find((s) => s.id === effectiveScenarioId)?.name ?? effectiveScenarioId;

    setDryRunResult(undefined);
    log.addEntry("info", `Running dry run for scenario "${scenarioName}"...`);
    log.addEntry("info", "Calling UP webhook...");

    runDryRun.mutate(
      { applicationId, scenarioId: effectiveScenarioId },
      {
        onSuccess: (data) => {
          setDryRunResult(data);
          if (data.success) {
            log.addEntry("success", "UP succeeded");
            log.addEntry("success", "DOWN succeeded");
            log.addEntry("success", "Dry run completed successfully");
          } else {
            const phase = data.phase.toUpperCase();
            log.addEntry("error", `${phase} failed: ${formatError(data.error)}`);
          }
        },
        onError: (error) => {
          log.addEntry("error", formatError(error));
        },
      },
    );
  }

  function handleComplete() {
    completeOnboarding.mutate(
      { applicationId },
      {
        onSuccess: () => {
          void navigate({ to: "/onboarding/url", search: { appId: applicationId } });
        },
      },
    );
  }

  return (
    <div className="py-16">
      <header className="mb-10 border-b border-border-dim pb-8">
        <div className="mb-4 flex size-12 items-center justify-center rounded-full border border-primary-ink/20 bg-surface-base">
          <FlaskIcon size={22} weight="duotone" className="text-primary-ink" />
        </div>
        <h1 className="text-4xl font-medium tracking-tight text-text-primary">Scenario Dry Run</h1>
        <p className="mt-3 font-mono text-sm text-text-secondary">
          Verify that your scenario webhook is working by running a test up/down cycle.
        </p>
      </header>

      {/* Step 1: Webhook configuration */}
      <section className="space-y-6">
        <div className="flex items-center justify-between">
          <h2 className="font-mono text-2xs uppercase tracking-widest text-text-tertiary">Webhook Configuration</h2>
          {isWebhookConfigured && (
            <button
              type="button"
              onClick={handleReconfigure}
              className="flex items-center gap-1.5 font-mono text-2xs text-text-tertiary transition-colors hover:text-primary-ink"
            >
              <PencilSimpleIcon size={12} />
              Change
            </button>
          )}
        </div>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="webhook-url" className="font-mono text-2xs uppercase tracking-widest text-text-tertiary">
              Webhook URL
            </label>
            <input
              id="webhook-url"
              type="url"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              placeholder="https://your-app.com/api/autonoma/webhook"
              disabled={isWebhookConfigured}
              className={cn(
                "w-full max-w-lg border border-border-dim bg-surface-base px-4 py-2.5 font-mono text-sm text-text-primary placeholder-text-tertiary/50 outline-none focus:border-primary-ink/50",
                isWebhookConfigured && "opacity-50",
              )}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="signing-secret" className="font-mono text-2xs uppercase tracking-widest text-text-tertiary">
              Signing Secret
            </label>
            <input
              id="signing-secret"
              type="password"
              value={signingSecret}
              onChange={(e) => setSigningSecret(e.target.value)}
              placeholder="your-signing-secret"
              disabled={isWebhookConfigured}
              className={cn(
                "w-full max-w-lg border border-border-dim bg-surface-base px-4 py-2.5 font-mono text-sm text-text-primary placeholder-text-tertiary/50 outline-none focus:border-primary-ink/50",
                isWebhookConfigured && "opacity-50",
              )}
            />
          </div>

          {/* Advanced: Custom Headers */}
          {!isWebhookConfigured && (
            <div>
              <button
                type="button"
                onClick={() => setShowAdvanced((prev) => !prev)}
                className="flex items-center gap-1.5 font-mono text-2xs text-text-tertiary transition-colors hover:text-text-secondary"
              >
                <CaretDownIcon
                  size={12}
                  className={cn("transition-transform", showAdvanced ? "rotate-0" : "-rotate-90")}
                />
                Advanced
              </button>

              {showAdvanced && (
                <div className="mt-3 space-y-3">
                  <label className="font-mono text-2xs uppercase tracking-widest text-text-tertiary">
                    Custom Headers
                  </label>
                  {customHeaders.map((header, index) => (
                    <div key={index} className="flex items-center gap-2">
                      <input
                        type="text"
                        value={header.key}
                        onChange={(e) => {
                          const next = [...customHeaders];
                          next[index] = { ...header, key: e.target.value };
                          setCustomHeaders(next);
                        }}
                        placeholder="Header name"
                        className="w-48 border border-border-dim bg-surface-base px-3 py-2 font-mono text-sm text-text-primary placeholder-text-tertiary/50 outline-none focus:border-primary-ink/50"
                      />
                      <input
                        type="text"
                        value={header.value}
                        onChange={(e) => {
                          const next = [...customHeaders];
                          next[index] = { ...header, value: e.target.value };
                          setCustomHeaders(next);
                        }}
                        placeholder="Value"
                        className="flex-1 border border-border-dim bg-surface-base px-3 py-2 font-mono text-sm text-text-primary placeholder-text-tertiary/50 outline-none focus:border-primary-ink/50"
                      />
                      <button
                        type="button"
                        onClick={() => setCustomHeaders(customHeaders.filter((_, i) => i !== index))}
                        className="flex size-9 shrink-0 items-center justify-center text-text-tertiary transition-colors hover:text-status-critical"
                      >
                        <TrashIcon size={14} />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => setCustomHeaders([...customHeaders, { key: "", value: "" }])}
                    className="flex items-center gap-1.5 font-mono text-2xs text-text-tertiary transition-colors hover:text-primary-ink"
                  >
                    <PlusIcon size={12} />
                    Add Header
                  </button>
                </div>
              )}
            </div>
          )}

          {!isWebhookConfigured && (
            <Button
              variant="accent"
              className="w-fit gap-2 px-6 py-3 font-mono text-sm font-bold uppercase"
              onClick={handleDiscoverScenarios}
              disabled={webhookUrl.length === 0 || signingSecret.length === 0 || discoverScenarios.isPending}
            >
              {discoverScenarios.isPending ? "Discovering..." : "Discover Scenarios"}
            </Button>
          )}
        </div>
      </section>

      {/* Step 2: Scenario selection + dry run */}
      {isWebhookConfigured && (
        <section className="mt-10 space-y-6 border-t border-border-dim pt-10">
          <h2 className="font-mono text-2xs uppercase tracking-widest text-text-tertiary">Test Scenario</h2>

          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="scenario-select"
                className="font-mono text-2xs uppercase tracking-widest text-text-tertiary"
              >
                Scenario
              </label>
              <select
                id="scenario-select"
                value={effectiveScenarioId ?? ""}
                onChange={(e) => {
                  setSelectedScenarioId(e.target.value);
                  setDryRunResult(undefined);
                }}
                className="w-full max-w-lg border border-border-dim bg-surface-base px-4 py-2.5 font-mono text-sm text-text-primary outline-none focus:border-primary-ink/50"
              >
                {scenarios.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>

            <Button
              variant="accent"
              className="w-fit gap-2 px-6 py-3 font-mono text-sm font-bold uppercase"
              onClick={handleRunDryRun}
              disabled={effectiveScenarioId == null || runDryRun.isPending}
            >
              <PlayIcon size={16} weight="bold" />
              {runDryRun.isPending ? "Running..." : "Run Dry Run"}
            </Button>
          </div>

          {/* Result display */}
          {dryRunResult != null && (
            <div
              className={cn(
                "flex items-start gap-3 border px-5 py-4",
                dryRunResult.success
                  ? "border-status-success/30 bg-status-success/5"
                  : "border-status-critical/30 bg-status-critical/5",
              )}
            >
              {dryRunResult.success ? (
                <>
                  <CheckCircleIcon size={20} weight="fill" className="mt-0.5 shrink-0 text-status-success" />
                  <div>
                    <p className="font-mono text-sm font-medium text-status-success">Setup successful!</p>
                    <p className="mt-1 font-mono text-2xs text-text-secondary">
                      Scenario up and down completed without errors. Your webhook is working correctly.
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <WarningCircleIcon size={20} weight="fill" className="mt-0.5 shrink-0 text-status-critical" />
                  <div>
                    <p className="font-mono text-sm font-medium text-status-critical">
                      Dry run failed during {dryRunResult.phase} phase
                    </p>
                    {dryRunResult.error != null && (
                      <p className="mt-1 font-mono text-2xs text-text-secondary">{formatError(dryRunResult.error)}</p>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </section>
      )}

      {/* Webhook log console */}
      <WebhookLog entries={log.entries} />

      {/* Complete button */}
      {dryRunPassed && (
        <section className="mt-10 border-t border-border-dim pt-10">
          <Button
            variant="accent"
            className="gap-3 px-8 py-4 font-mono text-sm font-bold uppercase"
            onClick={handleComplete}
            disabled={completeOnboarding.isPending}
          >
            {completeOnboarding.isPending ? "Continuing..." : "Continue"}
            <ArrowRightIcon size={18} weight="bold" />
          </Button>
        </section>
      )}
    </div>
  );
}
