import { Alert, AlertDescription, AlertTitle, Button, Input, Label, cn } from "@autonoma/blacklight";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { CircleIcon } from "@phosphor-icons/react/Circle";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import { FlaskIcon } from "@phosphor-icons/react/Flask";
import { GitBranchIcon } from "@phosphor-icons/react/GitBranch";
import { GlobeIcon } from "@phosphor-icons/react/Globe";
import { KeyIcon } from "@phosphor-icons/react/Key";
import { PencilSimpleIcon } from "@phosphor-icons/react/PencilSimple";
import { PlayIcon } from "@phosphor-icons/react/Play";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { RocketLaunchIcon } from "@phosphor-icons/react/RocketLaunch";
import { SpinnerGapIcon } from "@phosphor-icons/react/SpinnerGap";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { Navigate, createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  useCompleteOnboarding,
  useConfigureAndDiscoverScenarios,
  useOnboardingScenarios,
  useOnboardingStateOptional,
  useRunScenarioDryRun,
} from "lib/onboarding/onboarding-api";
import { toastManager } from "lib/toast-manager";
import { useCallback, useEffect, useRef, useState } from "react";
import { DocLink } from "./-components/doc-link";
import { OnboardingPageHeader } from "./-components/onboarding-page-header";
export const Route = createFileRoute("/_blacklight/onboarding/scenario-dry-run")({
  component: () => <Navigate to="/onboarding" search={{ step: "scenario-dry-run", appId: undefined }} />,
});

function StepNumber({ step, done }: { step: number; done: boolean }) {
  return (
    <div
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-full border font-mono text-xs font-bold transition-all",
        done
          ? "border-primary-ink bg-primary-ink text-surface-void"
          : "border-border-mid bg-surface-base text-text-tertiary",
      )}
    >
      {done ? <CheckCircleIcon size={16} weight="fill" /> : step}
    </div>
  );
}

function isValidUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

interface WebhookErrorDetails {
  title: string;
  hints: string[];
  field?: "url" | "secret" | "both";
}

function getWebhookErrorDetails(errorMessage: string): WebhookErrorDetails {
  const statusMatch = errorMessage.match(/Webhook returned status (\d+)/);
  if (statusMatch != null) {
    const status = Number(statusMatch[1]);
    switch (status) {
      case 401:
        return {
          title: "Authentication failed (401)",
          field: "secret",
          hints: [
            "The shared secret doesn't match. Verify that AUTONOMA_SHARED_SECRET on your deployment matches the value you entered above.",
          ],
        };
      case 403:
        return {
          title: "Forbidden (403)",
          field: "both",
          hints: [
            "The request was rejected by your endpoint.",
            "Check that AUTONOMA_SHARED_SECRET matches exactly - no extra spaces or line breaks.",
            'Verify AUTONOMA_ENABLED is set to "true" on your deployment.',
          ],
        };
      case 404:
        return {
          title: "Endpoint not found (404)",
          field: "url",
          hints: [
            "The webhook URL path doesn't exist. Verify the URL includes the correct route (e.g. /api/autonoma).",
            "Make sure the latest code changes have been deployed.",
          ],
        };
      case 500:
        return {
          title: "Server error (500)",
          hints: [
            "Your endpoint returned an internal error. Check your deployment logs for details.",
            "Verify that AUTONOMA_SHARED_SECRET is set.",
          ],
        };
      case 502:
      case 503:
      case 504:
        return {
          title: `Service unavailable (${status})`,
          field: "url",
          hints: [
            "Your deployment appears to be down or not ready yet.",
            "Wait for the deployment to finish, then try again.",
            "Make sure your app is running and accessible from the internet.",
          ],
        };
      default:
        return {
          title: `Unexpected response (${status})`,
          hints: ["Your endpoint returned an unexpected status code. Check your deployment logs for details."],
        };
    }
  }

  if (errorMessage.includes("timeout") || errorMessage.includes("abort")) {
    return {
      title: "Request timed out",
      field: "url",
      hints: [
        "The webhook didn't respond within 30 seconds.",
        "Make sure your deployment is running and accessible from the internet.",
      ],
    };
  }

  if (errorMessage.includes("fetch failed") || errorMessage.includes("ECONNREFUSED")) {
    return {
      title: "Connection failed",
      field: "url",
      hints: [
        "Could not connect to the webhook URL.",
        "Verify the URL is correct and your deployment is publicly accessible.",
        "If running locally, make sure the dev server is running.",
      ],
    };
  }

  if (errorMessage.includes("response validation failed")) {
    return {
      title: "Invalid response format",
      hints: [
        "The endpoint responded but the body doesn't match the expected schema.",
        "Make sure you're using the latest version of the Autonoma SDK.",
      ],
    };
  }

  return {
    title: "Discovery failed",
    hints: [errorMessage],
  };
}

function DiscoverErrorAlert({ error }: { error: { message: string } }) {
  const details = getWebhookErrorDetails(error.message);

  return (
    <Alert variant="critical">
      <AlertTitle>{details.title}</AlertTitle>
      <AlertDescription>
        <ul className="mt-1 space-y-1">
          {details.hints.map((hint) => (
            <li key={hint} className="flex items-start gap-2 leading-relaxed">
              <span className="mt-1 shrink-0 text-text-tertiary">-</span>
              <span>{hint}</span>
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
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

function generateHexSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function DeployPage({ appId }: { appId?: string }) {
  const applicationId = appId;

  const [generatedSecret] = useState(generateHexSecret);
  const [webhookUrlDraft, setWebhookUrlDraft] = useState<string>();
  const [webhookUrlTouched, setWebhookUrlTouched] = useState(false);
  const [signingSecret, setSigningSecret] = useState("");
  const [signingSecretTouched, setSigningSecretTouched] = useState(false);
  const [deployConfirmed, setDeployConfirmed] = useState(false);
  const [appUrl, setAppUrl] = useState("");
  const [appUrlTouched, setAppUrlTouched] = useState(false);
  const [customHeaders, setCustomHeaders] = useState<Array<{ key: string; value: string }>>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [forceReconfigure, setForceReconfigure] = useState(false);

  // Per-scenario dry run results, keyed by scenario id
  const [scenarioResults, setScenarioResults] = useState<
    Record<string, { success: boolean; phase?: string; error?: unknown }>
  >({});
  const [isDryRunning, setIsDryRunning] = useState(false);

  const navigate = useNavigate();
  const discoverScenarios = useConfigureAndDiscoverScenarios();
  const scenariosQuery = useOnboardingScenarios(applicationId ?? "");
  const onboardingStateQuery = useOnboardingStateOptional(applicationId ?? "");
  const runDryRun = useRunScenarioDryRun();
  const completeOnboarding = useCompleteOnboarding();
  const log = useLogEntries();

  const webhookUrl = webhookUrlDraft ?? "";
  const scenarios = scenariosQuery.data ?? [];
  const webhookConfirmed = !forceReconfigure && (onboardingStateQuery.data?.webhookConfigured ?? false);
  const isWebhookConfigured = webhookConfirmed && scenarios.length > 0;
  const isAppUrlValid = appUrl.length > 0 && isValidUrl(appUrl);

  const allDryRunsPassed = scenarios.length > 0 && scenarios.every((s) => scenarioResults[s.id]?.success === true);
  const anyDryRunFailed = scenarios.some((s) => scenarioResults[s.id]?.success === false);

  const discoverError = discoverScenarios.error;
  const discoverErrorDetails = discoverError != null ? getWebhookErrorDetails(discoverError.message) : undefined;
  const isUrlErrorField = discoverErrorDetails?.field === "url" || discoverErrorDetails?.field === "both";
  const isSecretErrorField = discoverErrorDetails?.field === "secret" || discoverErrorDetails?.field === "both";

  function handleDiscoverScenarios() {
    if (webhookUrl.length === 0 || !isValidUrl(webhookUrl) || signingSecret.length === 0 || applicationId == null)
      return;

    log.clear();
    log.addEntry("info", `Discovering scenarios at ${webhookUrl}...`);

    const headersRecord: Record<string, string> = {};
    for (const h of customHeaders) {
      if (h.key.length > 0) headersRecord[h.key] = h.value;
    }
    const webhookHeaders = Object.keys(headersRecord).length > 0 ? headersRecord : undefined;

    discoverScenarios.mutate(
      {
        applicationId,
        webhookUrl,
        signingSecret,
        webhookHeaders,
      },
      {
        onSuccess: () => {
          log.addEntry("success", "Scenarios discovered successfully");
          setScenarioResults({});
          setForceReconfigure(false);
        },
        onError: (error) => {
          log.addEntry("error", formatError(error));
        },
      },
    );
  }

  function handleReconfigure() {
    setForceReconfigure(true);
    setScenarioResults({});
    log.clear();
  }

  const handleRunAllDryRuns = useCallback(async () => {
    if (applicationId == null || scenarios.length === 0) return;

    setIsDryRunning(true);
    setScenarioResults({});
    log.clear();
    log.addEntry("info", `Running dry run for all ${scenarios.length} scenarios...`);

    for (const scenario of scenarios) {
      log.addEntry("info", `[${scenario.name}] Running up/down cycle...`);

      try {
        const result = await new Promise<{ success: boolean; phase?: string; error?: unknown }>((resolve, reject) => {
          runDryRun.mutate(
            { applicationId, scenarioId: scenario.id },
            {
              onSuccess: (data) => resolve(data),
              onError: (err) => reject(err),
            },
          );
        });

        setScenarioResults((prev) => ({ ...prev, [scenario.id]: result }));

        if (result.success) {
          log.addEntry("success", `[${scenario.name}] Passed`);
        } else {
          log.addEntry("error", `[${scenario.name}] Failed during ${result.phase} phase`);
        }
      } catch (err) {
        const errorResult = { success: false, error: err };
        setScenarioResults((prev) => ({ ...prev, [scenario.id]: errorResult }));
        log.addEntry("error", `[${scenario.name}] ${formatError(err)}`);
      }
    }

    setIsDryRunning(false);
  }, [applicationId, scenarios, runDryRun, log]);

  function handleComplete() {
    if (applicationId == null || !isAppUrlValid) return;

    completeOnboarding.mutate(
      { applicationId, productionUrl: appUrl },
      {
        onSuccess: () => {
          void navigate({ to: "/onboarding", search: { step: "github", appId: applicationId }, replace: true });
        },
      },
    );
  }

  const isCompleting = completeOnboarding.isPending;

  return (
    <>
      <OnboardingPageHeader
        leading={
          <div className="mb-4 flex size-12 items-center justify-center rounded-full border border-primary-ink/20 bg-surface-base">
            <FlaskIcon size={22} weight="duotone" className="text-primary-ink" />
          </div>
        }
        title="Deploy Autonoma SDK"
        description={
          <p className="max-w-2xl">
            The agent created an environment factory endpoint in your project. Now you need to deploy it and verify it
            works. Follow the steps below.
          </p>
        }
        descriptionClassName="text-sm"
      />

      {/* Step 1: Deploy changes */}
      <section className="space-y-4">
        <div className="flex items-start gap-4">
          <StepNumber step={1} done={deployConfirmed} />
          <div className="flex-1 space-y-3">
            <h2 className="text-lg font-medium text-text-primary">Deploy the changes the agent made</h2>
            <p className="max-w-2xl text-sm leading-relaxed text-text-secondary">
              The agent created an environment factory endpoint in your codebase (typically at{" "}
              <code className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-2xs text-primary-ink">
                /api/autonoma
              </code>
              ). You need to commit, push, and deploy these changes so the endpoint is reachable.{" "}
              <DocLink href="https://docs.agent.autonoma.app/guides/environment-factory/">
                See the Environment Factory guide
              </DocLink>
            </p>

            <div className="flex flex-col gap-3 border border-border-dim bg-surface-base p-4">
              <div className="flex items-center gap-2.5 text-sm text-text-secondary">
                <GitBranchIcon size={16} weight="bold" className="shrink-0 text-text-tertiary" />
                <span>Commit and push the agent's changes to your repository</span>
              </div>
              <div className="flex items-center gap-2.5 text-sm text-text-secondary">
                <RocketLaunchIcon size={16} weight="bold" className="shrink-0 text-text-tertiary" />
                <span>
                  Deploy to your hosting provider, or run{" "}
                  <code className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-2xs text-primary-ink">
                    npm run dev
                  </code>{" "}
                  locally
                </span>
              </div>
              <div className="flex items-start gap-2.5 text-sm text-text-secondary">
                <KeyIcon size={16} weight="bold" className="mt-0.5 shrink-0 text-text-tertiary" />
                <div className="flex flex-col gap-1.5">
                  <span>Set these environment variables on your deployed environment:</span>
                  <div className="flex flex-col gap-1 pl-1">
                    <div className="flex flex-col gap-1.5">
                      <div className="flex items-center gap-2 font-mono text-2xs">
                        <CircleIcon size={6} weight="fill" className="shrink-0 text-text-tertiary" />
                        <code className="rounded bg-surface-raised px-1.5 py-0.5 text-primary-ink">
                          AUTONOMA_SHARED_SECRET
                        </code>
                        <span className="font-sans text-text-tertiary">- HMAC secret for webhook verification</span>
                      </div>
                      <div className="ml-3.5 flex items-center gap-2">
                        <code className="truncate rounded bg-surface-raised px-1.5 py-0.5 font-mono text-2xs text-text-secondary">
                          {`${generatedSecret.slice(0, 8)}${"*".repeat(8)}${generatedSecret.slice(-4)}`}
                        </code>
                        <button
                          type="button"
                          title="Copy secret and auto-fill below"
                          className="flex shrink-0 items-center justify-center text-text-tertiary transition-colors hover:text-primary-ink"
                          onClick={() => {
                            void navigator.clipboard.writeText(`AUTONOMA_SHARED_SECRET=${generatedSecret}`).then(() => {
                              setSigningSecret(generatedSecret);
                              toastManager.add({
                                type: "success",
                                title: "Secret copied",
                                description: "AUTONOMA_SHARED_SECRET copied and auto-filled below.",
                              });
                            });
                          }}
                        >
                          <CopyIcon size={14} />
                        </button>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 font-mono text-2xs">
                      <CircleIcon size={6} weight="fill" className="shrink-0 text-text-tertiary" />
                      <code className="rounded bg-surface-raised px-1.5 py-0.5 text-primary-ink">
                        AUTONOMA_ENABLED=true
                      </code>
                      <button
                        type="button"
                        title="Copy environment variable"
                        className="flex shrink-0 items-center justify-center text-text-tertiary transition-colors hover:text-primary-ink"
                        onClick={() => {
                          void navigator.clipboard.writeText("AUTONOMA_ENABLED=true").then(() => {
                            toastManager.add({
                              type: "success",
                              title: "Copied",
                              description: "AUTONOMA_ENABLED=true",
                            });
                          });
                        }}
                      >
                        <CopyIcon size={14} />
                      </button>
                      <span className="font-sans text-text-tertiary">- enables the endpoint in production</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {!deployConfirmed && (
              <Button
                variant="accent"
                className="w-fit gap-2 px-6 py-3 font-mono text-sm font-bold uppercase"
                onClick={() => setDeployConfirmed(true)}
              >
                <CheckCircleIcon size={16} weight="bold" />
                I've deployed my changes
              </Button>
            )}
          </div>
        </div>
      </section>

      {/* Step 2: Webhook URL + Secret */}
      {deployConfirmed && (
        <section className="mt-10 space-y-4 border-t border-border-dim pt-10">
          <div className="flex items-start gap-4">
            <StepNumber step={2} done={isWebhookConfigured} />
            <div className="flex-1 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-medium text-text-primary">Connect your webhook</h2>
                  <p className="mt-1 max-w-2xl text-sm leading-relaxed text-text-secondary">
                    Provide the URL where the environment factory is running. Autonoma will call this endpoint to set up
                    and tear down test data before each run.
                  </p>
                </div>
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
                  <Label htmlFor="webhook-url">Webhook URL</Label>
                  <p className="text-2xs text-text-tertiary">
                    The full URL of the environment factory endpoint. This is typically your app's base URL plus the
                    path the agent created (e.g. /api/autonoma).
                  </p>
                  <Input
                    id="webhook-url"
                    type="url"
                    value={webhookUrl}
                    onChange={(e) => {
                      setWebhookUrlDraft(e.target.value);
                      discoverScenarios.reset();
                    }}
                    onBlur={() => setWebhookUrlTouched(true)}
                    aria-invalid={
                      (webhookUrlTouched && webhookUrl.length > 0 && !isValidUrl(webhookUrl)) || isUrlErrorField
                    }
                    placeholder="https://staging.your-app.com/api/autonoma"
                    disabled={isWebhookConfigured}
                    className="max-w-lg"
                  />
                  {webhookUrlTouched && webhookUrl.length > 0 && !isValidUrl(webhookUrl) && (
                    <p className="text-2xs text-status-critical">Enter a valid URL starting with http:// or https://</p>
                  )}
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="signing-secret">Shared Secret</Label>
                  <p className="text-2xs text-text-tertiary">
                    Copy the{" "}
                    <code className="rounded bg-surface-raised px-1 py-0.5 font-mono text-2xs">
                      AUTONOMA_SHARED_SECRET
                    </code>{" "}
                    from your project's{" "}
                    <code className="rounded bg-surface-raised px-1 py-0.5 font-mono text-2xs">.env.local</code> or{" "}
                    <code className="rounded bg-surface-raised px-1 py-0.5 font-mono text-2xs">.env</code> file. This is
                    the same secret your deployed endpoint uses to verify requests.
                  </p>
                  <Input
                    id="signing-secret"
                    type="password"
                    value={signingSecret}
                    onChange={(e) => {
                      setSigningSecret(e.target.value);
                      discoverScenarios.reset();
                    }}
                    onBlur={() => setSigningSecretTouched(true)}
                    aria-invalid={(signingSecretTouched && signingSecret.length === 0) || isSecretErrorField}
                    placeholder="your-shared-secret"
                    disabled={isWebhookConfigured}
                    className="max-w-lg"
                  />
                  {signingSecretTouched && signingSecret.length === 0 && (
                    <p className="text-2xs text-status-critical">Shared secret is required</p>
                  )}
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
                        <Label>Custom Headers</Label>
                        {customHeaders.map((header, index) => (
                          <div key={index} className="flex items-center gap-2">
                            <Input
                              type="text"
                              value={header.key}
                              onChange={(e) => {
                                const next = [...customHeaders];
                                next[index] = { ...header, key: e.target.value };
                                setCustomHeaders(next);
                              }}
                              placeholder="Header name"
                              className="w-48"
                            />
                            <Input
                              type="text"
                              value={header.value}
                              onChange={(e) => {
                                const next = [...customHeaders];
                                next[index] = { ...header, value: e.target.value };
                                setCustomHeaders(next);
                              }}
                              placeholder="Value"
                              className="flex-1"
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
                  <>
                    <Button
                      variant="accent"
                      className="w-fit gap-2 px-6 py-3 font-mono text-sm font-bold uppercase"
                      onClick={handleDiscoverScenarios}
                      disabled={
                        webhookUrl.length === 0 ||
                        !isValidUrl(webhookUrl) ||
                        signingSecret.length === 0 ||
                        discoverScenarios.isPending ||
                        applicationId == null
                      }
                    >
                      <GlobeIcon size={16} weight="bold" />
                      {discoverScenarios.isPending ? "Discovering..." : "Discover Scenarios"}
                    </Button>

                    {discoverError != null && <DiscoverErrorAlert error={discoverError} />}
                  </>
                )}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Step 3: Dry run all scenarios */}
      {isWebhookConfigured && (
        <section className="mt-10 space-y-4 border-t border-border-dim pt-10">
          <div className="flex items-start gap-4">
            <StepNumber step={3} done={allDryRunsPassed} />
            <div className="flex-1 space-y-4">
              <div>
                <h2 className="text-lg font-medium text-text-primary">Verify with a dry run</h2>
                <p className="mt-1 max-w-2xl text-sm leading-relaxed text-text-secondary">
                  Run a dry run for all {scenarios.length} scenario{scenarios.length !== 1 ? "s" : ""}. This calls your
                  webhook to create test data (up), then immediately tear it down (down) - verifying the full cycle
                  works.{" "}
                  <DocLink href="https://docs.agent.autonoma.app/test-planner/step-2-scenarios/">
                    Learn more about scenarios
                  </DocLink>
                </p>
              </div>

              {/* Scenario results list */}
              {scenarios.length > 0 && Object.keys(scenarioResults).length > 0 && (
                <div className="flex flex-col gap-2">
                  {scenarios.map((s) => {
                    const result = scenarioResults[s.id];
                    return (
                      <div key={s.id} className="flex items-center gap-3 font-mono text-sm">
                        {result == null ? (
                          <SpinnerGapIcon size={16} className="shrink-0 animate-spin text-text-tertiary" />
                        ) : result.success ? (
                          <CheckCircleIcon size={16} weight="fill" className="shrink-0 text-status-success" />
                        ) : (
                          <WarningCircleIcon size={16} weight="fill" className="shrink-0 text-status-critical" />
                        )}
                        <span className={cn("text-2xs", result?.success === false && "text-status-critical")}>
                          {s.name}
                          {result?.success === false &&
                            result.phase != null &&
                            ` - failed during ${result.phase} phase`}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="flex items-center gap-3">
                <Button
                  variant="accent"
                  className="w-fit gap-2 px-6 py-3 font-mono text-sm font-bold uppercase"
                  onClick={() => void handleRunAllDryRuns()}
                  disabled={isDryRunning}
                >
                  <PlayIcon size={16} weight="bold" />
                  {isDryRunning ? "Running..." : anyDryRunFailed ? "Retry Dry Run" : "Run Dry Run"}
                </Button>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Webhook log console */}
      <WebhookLog entries={log.entries} />

      {/* Step 4: App URL + Continue */}
      {allDryRunsPassed && (
        <section className="mt-10 space-y-4 border-t border-border-dim pt-10">
          <div className="flex items-start gap-4">
            <StepNumber step={4} done={isAppUrlValid} />
            <div className="flex-1 space-y-4">
              <div>
                <h2 className="text-lg font-medium text-text-primary">Set your application URL</h2>
                <p className="mt-1 max-w-2xl text-sm leading-relaxed text-text-secondary">
                  Where should Autonoma run tests? Use your staging or preview environment - somewhere that closely
                  mirrors production but where test data won't affect real users. You can change this later in settings.
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="app-url">Application URL</Label>
                <Input
                  id="app-url"
                  type="url"
                  value={appUrl}
                  onChange={(e) => setAppUrl(e.target.value)}
                  onBlur={() => setAppUrlTouched(true)}
                  aria-invalid={appUrlTouched && appUrl.length > 0 && !isValidUrl(appUrl)}
                  placeholder="https://staging.your-app.com"
                  className="max-w-lg"
                />
                {appUrlTouched && appUrl.length > 0 && !isValidUrl(appUrl) && (
                  <p className="text-2xs text-status-critical">Enter a valid URL starting with http:// or https://</p>
                )}
              </div>

              {isAppUrlValid && (
                <Button
                  variant="accent"
                  className="gap-3 px-8 py-4 font-mono text-sm font-bold uppercase"
                  onClick={handleComplete}
                  disabled={isCompleting}
                  aria-label="onboarding-complete"
                >
                  {isCompleting ? "Completing..." : "Continue"}
                  <ArrowRightIcon size={18} weight="bold" />
                </Button>
              )}
            </div>
          </div>
        </section>
      )}
    </>
  );
}
