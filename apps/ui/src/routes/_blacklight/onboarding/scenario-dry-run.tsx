import { Button, cn } from "@autonoma/blacklight";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { FlaskIcon } from "@phosphor-icons/react/Flask";
import { PlayIcon } from "@phosphor-icons/react/Play";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { createFileRoute } from "@tanstack/react-router";
import {
  useCompleteOnboarding,
  useConfigureAndDiscoverScenarios,
  useOnboardingScenarios,
  useRunScenarioDryRun,
} from "lib/onboarding/onboarding-api";
import { useState } from "react";
import { getOnboardingApplicationId } from "./install";

export const Route = createFileRoute("/_blacklight/onboarding/scenario-dry-run")({
  component: ScenarioDryRunPage,
});

interface DryRunResult {
  success: boolean;
  phase: "up" | "down";
  error: unknown;
}

function ScenarioDryRunPage() {
  const applicationId = getOnboardingApplicationId();

  const [webhookUrl, setWebhookUrl] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const [selectedScenarioId, setSelectedScenarioId] = useState<string>();
  const [dryRunResult, setDryRunResult] = useState<DryRunResult>();

  const discoverScenarios = useConfigureAndDiscoverScenarios();
  const scenariosQuery = useOnboardingScenarios(applicationId ?? "");
  const runDryRun = useRunScenarioDryRun();
  const completeOnboarding = useCompleteOnboarding();

  const scenarios = scenariosQuery.data ?? [];
  const isWebhookConfigured = scenarios.length > 0;
  const effectiveScenarioId = selectedScenarioId ?? scenarios[0]?.id;
  const dryRunPassed = dryRunResult?.success === true;

  function handleDiscoverScenarios() {
    if (webhookUrl.length === 0 || signingSecret.length === 0 || applicationId == null) return;

    discoverScenarios.mutate(
      { applicationId, webhookUrl, signingSecret },
      {
        onSuccess: () => {
          setSelectedScenarioId(undefined);
          setDryRunResult(undefined);
        },
      },
    );
  }

  function handleRunDryRun() {
    if (effectiveScenarioId == null || applicationId == null) return;

    setDryRunResult(undefined);
    runDryRun.mutate(
      { applicationId, scenarioId: effectiveScenarioId },
      {
        onSuccess: (data) => {
          setDryRunResult(data);
        },
      },
    );
  }

  function handleComplete() {
    if (applicationId == null) return;

    completeOnboarding.mutate(
      { applicationId },
      {
        onSuccess: () => {
          window.location.replace("/onboarding/url");
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
        <h2 className="font-mono text-2xs uppercase tracking-widest text-text-tertiary">Webhook Configuration</h2>

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

          {!isWebhookConfigured && (
            <Button
              variant="accent"
              className="w-fit gap-2 px-6 py-3 font-mono text-sm font-bold uppercase"
              onClick={handleDiscoverScenarios}
              disabled={
                webhookUrl.length === 0 ||
                signingSecret.length === 0 ||
                discoverScenarios.isPending ||
                applicationId == null
              }
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
                      <p className="mt-1 font-mono text-2xs text-text-secondary">
                        {typeof dryRunResult.error === "object" &&
                        dryRunResult.error != null &&
                        "message" in dryRunResult.error
                          ? String(dryRunResult.error.message)
                          : String(dryRunResult.error)}
                      </p>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </section>
      )}

      {/* Complete button */}
      {dryRunPassed && (
        <section className="mt-10 border-t border-border-dim pt-10">
          <Button
            variant="accent"
            className="gap-3 px-8 py-4 font-mono text-sm font-bold uppercase"
            onClick={handleComplete}
            disabled={completeOnboarding.isPending}
          >
            {completeOnboarding.isPending ? "Completing..." : "Complete Onboarding"}
            <ArrowRightIcon size={18} weight="bold" />
          </Button>
        </section>
      )}
    </div>
  );
}
