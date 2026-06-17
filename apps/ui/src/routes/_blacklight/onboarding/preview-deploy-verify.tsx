import { Badge, Button, Skeleton, cn } from "@autonoma/blacklight";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import { GlobeIcon } from "@phosphor-icons/react/Globe";
import { PencilSimpleIcon } from "@phosphor-icons/react/PencilSimple";
import { RocketLaunchIcon } from "@phosphor-icons/react/RocketLaunch";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { Navigate, createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { BuildLogStreamViewer, buildPreviewLogStreamUrl } from "components/build-logs/build-log-stream-viewer";
import {
  useCompletePreviewOnboarding,
  usePreviewReadiness,
  useTriggerPreviewkitMainDeploy,
} from "lib/onboarding/onboarding-api";
import { buildOnboardingSearch } from "lib/onboarding/onboarding-search";
import { useApplications } from "lib/query/applications.queries";
import { toastManager } from "lib/toast-manager";
import { Suspense } from "react";
import { setLastApp } from "../_app-shell/-last-app";
import { OnboardingPageHeader } from "./-components/onboarding-page-header";

export const Route = createFileRoute("/_blacklight/onboarding/preview-deploy-verify")({
  component: () => <Navigate to="/onboarding" search={buildOnboardingSearch("deploy-verify")} />,
});

type PreviewReadinessData = ReturnType<typeof usePreviewReadiness>["data"];
type PreviewFailure = NonNullable<PreviewReadinessData["diagnostics"]["failures"]>[number];

export function PreviewDeployVerifyPage({ appId }: { appId?: string }) {
  if (appId == null) {
    return <p className="font-mono text-sm text-text-secondary">No application found. Please start from setup.</p>;
  }

  return (
    <Suspense fallback={<PreviewDeployVerifySkeleton />}>
      <PreviewDeployVerifyContent appId={appId} />
    </Suspense>
  );
}

function PreviewDeployVerifySkeleton() {
  return (
    <div className="space-y-8">
      <Skeleton className="h-28 w-full" />
      <div className="grid gap-6 lg:grid-cols-2">
        <Skeleton className="h-72 w-full" />
        <Skeleton className="h-72 w-full" />
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

function PreviewDeployVerifyContent({ appId }: { appId: string }) {
  const navigate = useNavigate();
  const router = useRouter();
  const { data } = usePreviewReadiness(appId);
  const { data: applications } = useApplications();
  const redeploy = useTriggerPreviewkitMainDeploy();
  const complete = useCompletePreviewOnboarding();
  const application = applications.find((app) => app.id === appId);
  const isReady = data.diagnostics.status === "ready";
  const failures = data.diagnostics.failures ?? [];

  function copyForAgent() {
    const firstFailure = failures[0];
    const payload = {
      previewUrl: data.previewUrl,
      diagnostics: data.diagnostics,
      services: data.services,
      configHint:
        firstFailure != null
          ? {
              step: "previewkit-config",
              appName: firstFailure.appName,
              fieldPath: firstFailure.fieldPath,
            }
          : undefined,
    };
    void navigator.clipboard.writeText(JSON.stringify(payload, undefined, 2)).then(() => {
      toastManager.add({ type: "success", title: "Preview details copied" });
    });
  }

  function completeOnboarding() {
    if (application == null) {
      toastManager.add({ type: "critical", title: "Application not found" });
      return;
    }

    complete.mutate(
      { applicationId: appId },
      {
        onSuccess: async () => {
          setLastApp(application.slug);
          await router.invalidate();
          void navigate({
            to: "/app/$appSlug",
            params: { appSlug: application.slug },
            replace: true,
          });
        },
      },
    );
  }

  function redeployPreviewkit() {
    redeploy.mutate({ applicationId: appId });
  }

  function editConfig(failure?: PreviewFailure) {
    void navigate({
      to: "/onboarding",
      search: buildOnboardingSearch(
        data.mode === "existing_deploys" ? "existing-deploys" : "previewkit-config",
        appId,
        { focusApp: failure?.appName, focusField: fieldFromPath(failure?.fieldPath), focusSection: "config" },
      ),
    });
  }

  function editSecrets() {
    const failureWithApp = failures.find((failure) => failure.appName != null);
    void navigate({
      to: "/onboarding",
      search: buildOnboardingSearch("previewkit-config", appId, {
        focusApp: failureWithApp?.appName,
        focusSection: "secrets",
      }),
    });
  }

  return (
    <>
      <OnboardingPageHeader
        leading={
          <div className="mb-4 flex size-12 items-center justify-center border border-primary-ink/30 bg-surface-base">
            <RocketLaunchIcon size={22} weight="duotone" className="text-primary-ink" />
          </div>
        }
        title={isReady ? "You're connected" : "Deploying your preview"}
        description={
          <p className="max-w-3xl">
            {isReady
              ? "The preview URL is live. Autonoma can now use it as the target for generated browser tests."
              : "Watch for a ready URL. If the deploy fails, fix the config or secrets and retry."}
          </p>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(28rem,1fr)]">
        <section className="border border-border-dim bg-surface-base p-6">
          <div className="flex items-start gap-4">
            <StatusIcon status={data.diagnostics.status} />
            <div className="min-w-0 flex-1">
              <p className="font-mono text-2xs uppercase tracking-widest text-text-secondary">Readiness</p>
              <h2 className="mt-2 text-2xl font-medium text-text-primary">{statusTitle(data.diagnostics.status)}</h2>
              {data.previewUrl != null ? (
                <a
                  href={data.previewUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-4 inline-flex max-w-full items-center gap-2 truncate font-mono text-sm text-primary-ink"
                >
                  <GlobeIcon size={15} />
                  {data.previewUrl}
                </a>
              ) : (
                <p className="mt-4 text-sm text-text-secondary">No preview URL has been reported yet.</p>
              )}
              {failures.length > 0 ? (
                <div className="mt-5 space-y-3">
                  {failures.map((failure) => (
                    <FailureCard
                      key={`${failure.code}:${failure.appName ?? ""}:${failure.message}`}
                      failure={failure}
                      onEditConfig={data.mode === "previewkit" ? () => editConfig(failure) : undefined}
                    />
                  ))}
                </div>
              ) : data.diagnostics.error != null ? (
                <div className="mt-5 border-l-2 border-status-critical bg-status-critical/10 px-4 py-3">
                  <p className="font-mono text-2xs uppercase tracking-widest text-status-critical">Blocking error</p>
                  <p className="mt-2 text-sm text-text-secondary">{data.diagnostics.error}</p>
                </div>
              ) : undefined}
            </div>
          </div>

          <div className="mt-8 flex flex-wrap gap-3">
            {isReady ? (
              <Button
                variant="accent"
                className="gap-2 px-6 py-3"
                onClick={completeOnboarding}
                disabled={complete.isPending}
              >
                {complete.isPending ? "Starting..." : "Start generating tests"}
                <ArrowRightIcon size={16} weight="bold" />
              </Button>
            ) : undefined}
            {data.mode === "previewkit" && data.diagnostics.actions.includes("redeploy") ? (
              <Button variant="outline" className="gap-2" onClick={redeployPreviewkit} disabled={redeploy.isPending}>
                <RocketLaunchIcon size={15} />
                {redeploy.isPending ? "Redeploying..." : "Redeploy"}
              </Button>
            ) : undefined}
            {data.diagnostics.actions.includes("edit_config") ? (
              <Button variant="outline" onClick={() => editConfig()}>
                Edit config
              </Button>
            ) : undefined}
            {data.mode === "previewkit" && data.diagnostics.actions.includes("edit_secrets") ? (
              <Button variant="outline" onClick={editSecrets}>
                Edit secrets
              </Button>
            ) : undefined}
            {data.diagnostics.actions.includes("copy_for_agent") ? (
              <Button variant="outline" className="gap-2" onClick={copyForAgent}>
                <CopyIcon size={14} />
                Copy for agent
              </Button>
            ) : undefined}
          </div>
        </section>

        <PreviewDiagnosticsPanel diagnostics={data.diagnostics} services={data.services} />
      </div>

      {data.diagnostics.logs.available ? (
        <section className="mt-6 border border-border-dim bg-surface-base">
          <div className="border-b border-border-dim bg-surface-raised px-5 py-4">
            <h2 className="font-mono text-sm font-bold uppercase tracking-widest text-text-primary">Build logs</h2>
          </div>
          <div className="p-5">
            <BuildLogStreamViewer url={logStreamUrl(data.diagnostics.logs)} />
          </div>
        </section>
      ) : undefined}
    </>
  );
}

function logStreamUrl(logs: { repoFullName: string; prNumber: number }): string {
  const [owner = "", repo = ""] = logs.repoFullName.split("/");
  return buildPreviewLogStreamUrl(owner, repo, logs.prNumber);
}

/** Extracts the field key from an `apps.<i>.<field>` path so the config screen can focus the exact input. */
function fieldFromPath(fieldPath: string | undefined): string | undefined {
  if (fieldPath == null) return undefined;
  const segments = fieldPath.split(".");
  return segments[2];
}

function FailureCard({ failure, onEditConfig }: { failure: PreviewFailure; onEditConfig?: () => void }) {
  return (
    <div className="border-l-2 border-status-critical bg-status-critical/10 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="critical" className="font-mono uppercase">
          {failure.code}
        </Badge>
        {failure.appName != null ? (
          <span className="font-mono text-2xs text-text-secondary">{failure.appName}</span>
        ) : undefined}
      </div>
      <p className="mt-2 text-sm text-text-secondary">{failure.message}</p>
      {onEditConfig != null && failure.appName != null ? (
        <Button variant="outline" size="xs" className="mt-3 gap-1" onClick={onEditConfig}>
          <PencilSimpleIcon size={12} />
          Fix in config
        </Button>
      ) : undefined}
    </div>
  );
}

function PreviewDiagnosticsPanel({
  diagnostics,
  services,
}: {
  diagnostics: PreviewReadinessData["diagnostics"];
  services: PreviewReadinessData["services"];
}) {
  return (
    <section className="border border-border-dim bg-surface-base">
      <div className="border-b border-border-dim bg-surface-raised px-5 py-4">
        <h2 className="font-mono text-sm font-bold uppercase tracking-widest text-text-primary">Diagnostics</h2>
      </div>
      <div className="divide-y divide-border-dim">
        <div className="p-5">
          <p className="font-mono text-2xs uppercase tracking-widest text-text-secondary">Status</p>
          <p className="mt-2 text-sm text-text-secondary">
            {diagnostics.phase ?? diagnostics.status}
            {diagnostics.logs.available ? " · logs available" : ""}
          </p>
          {!diagnostics.logs.available ? (
            <p className="mt-2 text-2xs text-text-secondary">Logs are not available for this environment yet.</p>
          ) : undefined}
        </div>
        <div className="p-5">
          <p className="font-mono text-2xs uppercase tracking-widest text-text-secondary">Services</p>
          <div className="mt-4 space-y-3">
            {services.length === 0 ? (
              <p className="text-sm text-text-secondary">No service details yet.</p>
            ) : (
              services.map((service) => (
                <div key={service.name} className="border border-border-dim px-3 py-2">
                  <div className="flex items-center gap-3">
                    <span className={cn("size-2", serviceStatusColor(service.status))} />
                    <span className="font-mono text-sm text-text-primary">{service.name}</span>
                    <span className="ml-auto font-mono text-2xs text-text-secondary">
                      {service.port != null ? `:${service.port}` : service.status}
                    </span>
                  </div>
                  {service.url != null ? (
                    <p className="mt-1 truncate font-mono text-2xs text-primary-ink">{service.url}</p>
                  ) : undefined}
                  {service.error != null ? (
                    <p className="mt-1 text-2xs text-status-critical">{service.error}</p>
                  ) : undefined}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function StatusIcon({ status }: { status: "idle" | "building" | "ready" | "failed" }) {
  if (status === "ready") return <CheckCircleIcon size={28} weight="fill" className="shrink-0 text-status-success" />;
  if (status === "failed")
    return <WarningCircleIcon size={28} weight="fill" className="shrink-0 text-status-critical" />;
  return <RocketLaunchIcon size={28} weight="duotone" className="shrink-0 text-primary-ink" />;
}

function statusTitle(status: "idle" | "building" | "ready" | "failed") {
  if (status === "ready") return "Preview ready";
  if (status === "building") return "Preview building";
  if (status === "failed") return "Preview blocked";
  return "Waiting for preview";
}

function serviceStatusColor(status: "ready" | "building" | "failed" | "unknown") {
  if (status === "ready") return "bg-status-success";
  if (status === "failed") return "bg-status-critical";
  if (status === "building") return "bg-status-warn";
  return "bg-border-mid";
}
