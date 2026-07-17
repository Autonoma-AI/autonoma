import {
  Badge,
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  buttonVariants,
} from "@autonoma/blacklight";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import { LinkIcon } from "@phosphor-icons/react/Link";
import { PlugsIcon } from "@phosphor-icons/react/Plugs";
import { SlidersHorizontalIcon } from "@phosphor-icons/react/SlidersHorizontal";
import { Navigate, createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  useAvailableVercelProjects,
  useConfirmExistingDeploysSetup,
  useDeploymentSignalStatus,
  useLinkVercelProject,
} from "lib/onboarding/onboarding-api";
import { type OnboardingSignalProvider, buildOnboardingSearch } from "lib/onboarding/onboarding-search";
import { useApplicationSharedSecret } from "lib/query/applications.queries";
import { toastManager } from "lib/toast-manager";
import { type ReactNode, useState } from "react";
import { OnboardingPageHeader } from "./-components/onboarding-page-header";

export const Route = createFileRoute("/_blacklight/onboarding/existing-deploys")({
  component: () => <Navigate to="/onboarding" search={buildOnboardingSearch("existing-deploys")} />,
});

export function ExistingDeploysPage({
  appId,
  initialProvider,
}: {
  appId?: string;
  initialProvider?: OnboardingSignalProvider;
}) {
  const navigate = useNavigate();
  const sharedSecretQuery = useApplicationSharedSecret(appId ?? "");
  const signalStatusQuery = useDeploymentSignalStatus(appId ?? "");
  const vercelProjectsQuery = useAvailableVercelProjects(appId ?? "");
  const confirmSetup = useConfirmExistingDeploysSetup();
  const [selectedProvider, setSelectedProvider] = useState<OnboardingSignalProvider>(initialProvider ?? "vercel");

  // On the Vercel path, a linked project is required before continuing - without
  // it there's no protection-bypass header, so generated tests can never reach
  // the preview.
  const vercelProjectLinked = vercelProjectsQuery.data?.linkedProject != null;
  const canContinue = selectedProvider !== "vercel" || vercelProjectLinked;

  function goToVerify() {
    void navigate({ to: "/onboarding", search: buildOnboardingSearch("deploy-verify", appId) });
  }

  function continueToVerify() {
    if (appId == null) return goToVerify();
    // Mark setup as done (configuring -> waiting). The waiting state is
    // idempotent and a signal that already advanced the row to preview_verified
    // surfaces as a step-mismatch that redirects forward, so navigate regardless.
    confirmSetup.mutate({ applicationId: appId }, { onSettled: goToVerify });
  }
  const endpoint = `${window.location.origin}/v1/onboarding/deployment-signal`;
  const sharedSecret = sharedSecretQuery.data?.sharedSecret ?? "AUTONOMA_SHARED_SECRET";
  const workflow = buildWorkflowSnippet({ applicationId: appId ?? "APPLICATION_ID", endpoint });
  const payloadPreview = buildPayloadPreview(appId ?? "APPLICATION_ID");

  function backToPreviewOptions() {
    void navigate({ to: "/onboarding", search: buildOnboardingSearch("preview-environment", appId) });
  }

  function copyWorkflow() {
    void navigator.clipboard.writeText(workflow).then(() => {
      toastManager.add({ type: "success", title: "Workflow copied" });
    });
  }

  function copySecret() {
    void navigator.clipboard.writeText(`AUTONOMA_SHARED_SECRET=${sharedSecret}`).then(() => {
      toastManager.add({ type: "success", title: "Secret copied" });
    });
  }

  if (appId == null) {
    return <p className="font-mono text-sm text-text-secondary">No application found. Please start from setup.</p>;
  }

  return (
    <>
      <OnboardingPageHeader
        leading={
          <div className="mb-4 flex size-12 items-center justify-center border border-primary-ink/30 bg-surface-base">
            <PlugsIcon size={22} weight="duotone" className="text-primary-ink" />
          </div>
        }
        title="Connect your deploys"
        description={
          <p className="max-w-3xl">
            Keep deploying the way you do today. Autonoma only needs a signed signal when a preview URL is live.
          </p>
        }
      />

      <Button variant="ghost" size="sm" className="mb-6 w-fit gap-2" onClick={backToPreviewOptions}>
        <ArrowLeftIcon size={14} />
        Back to preview options
      </Button>

      <div className="grid gap-5 lg:grid-cols-4">
        <ProviderCard
          active={selectedProvider === "vercel"}
          icon={<VercelIcon />}
          title="Vercel"
          meta="Connect project"
          onClick={() => setSelectedProvider("vercel")}
        />
        <ProviderCard
          active={selectedProvider === "custom"}
          icon={<SlidersHorizontalIcon size={22} />}
          title="Custom"
          meta="Webhook"
          onClick={() => setSelectedProvider("custom")}
        />
        <ProviderCard icon={<PlugsIcon size={22} />} title="Netlify" meta="Soon" disabled />
        <ProviderCard icon={<PlugsIcon size={22} />} title="Render" meta="Soon" disabled />
      </div>

      {selectedProvider === "vercel" ? <VercelConnectSection appId={appId} /> : undefined}

      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(28rem,1fr)]">
        <section className="border border-border-dim bg-surface-base">
          <div className="border-b border-border-dim bg-surface-raised px-5 py-4">
            <h2 className="font-mono text-sm font-bold uppercase tracking-widest text-text-primary">
              How the signal works
            </h2>
          </div>
          <div className="space-y-5 p-6">
            <SignalStep
              index="01"
              title="Your provider builds a preview"
              text="Use the URL your CI or hosting provider exposes."
            />
            <SignalStep
              index="02"
              title="CI signs the payload"
              text="The body is signed with AUTONOMA_SHARED_SECRET."
            />
            <SignalStep
              index="03"
              title="Autonoma stores the URL"
              text="The URL becomes the preview target for onboarding."
            />
            <div className="border-l-2 border-status-warn bg-status-warn/10 px-4 py-3">
              <p className="font-mono text-2xs uppercase tracking-widest text-status-warn">Secret</p>
              <p className="mt-2 text-sm text-text-secondary">
                Add <span className="font-mono text-primary-ink">AUTONOMA_SHARED_SECRET</span> to your CI secrets.
              </p>
              <Button variant="outline" size="xs" className="mt-3 gap-2" onClick={copySecret}>
                <CopyIcon size={13} />
                Copy secret
              </Button>
            </div>
            <div className="border border-border-dim bg-surface-raised/40 p-4">
              <p className="font-mono text-2xs uppercase tracking-widest text-text-secondary">Signal payload</p>
              <pre className="mt-3 overflow-auto font-mono text-2xs text-text-primary">{payloadPreview}</pre>
              <p className="mt-3 text-sm text-text-secondary">
                Sign the exact raw JSON body with HMAC SHA256 and send the hex digest in{" "}
                <span className="font-mono text-text-primary">x-signature</span>.
              </p>
            </div>
          </div>
        </section>

        <section className="border border-border-dim bg-surface-base">
          <div className="flex items-center justify-between border-b border-border-dim bg-surface-raised px-5 py-4">
            <h2 className="font-mono text-sm font-bold uppercase tracking-widest text-text-primary">
              Autonoma preview signal
            </h2>
            <Button variant="outline" size="xs" className="gap-2" onClick={copyWorkflow}>
              <CopyIcon size={13} />
              Copy
            </Button>
          </div>
          <pre className="max-h-[34rem] overflow-auto p-6 font-mono text-2xs leading-relaxed text-text-primary">
            {workflow}
          </pre>
        </section>
      </div>

      <section className="mt-6 border border-border-dim bg-surface-base p-5">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="font-mono text-sm font-bold uppercase tracking-widest text-text-primary">Signal status</h2>
          {signalStatusQuery.data?.previewUrl != null ? (
            <Badge variant="success">accepted</Badge>
          ) : (
            <Badge variant="outline">waiting for signal</Badge>
          )}
        </div>
        {signalStatusQuery.data?.previewUrl != null ? (
          <div className="mt-3 space-y-1 text-sm text-text-secondary">
            <p>
              Preview URL:{" "}
              <a
                href={signalStatusQuery.data.previewUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-primary-ink underline-offset-4 hover:underline"
              >
                {signalStatusQuery.data.previewUrl}
              </a>
            </p>
            {signalStatusQuery.data.acceptedAt != null ? (
              <p>Accepted at {signalStatusQuery.data.acceptedAt}</p>
            ) : undefined}
          </div>
        ) : (
          <p className="mt-3 text-sm text-text-secondary">
            Waiting for CI to POST a valid signed payload to the deployment signal endpoint.
          </p>
        )}
      </section>

      <div className="mt-8 flex justify-between border-t border-border-dim pt-6">
        <p className="max-w-xl text-sm text-text-secondary">
          {!canContinue
            ? "Link a Vercel project above before continuing."
            : "After CI sends the signal, the next screen will show whether Autonoma has a usable preview URL."}
        </p>
        <Button
          variant="accent"
          className="gap-2 px-6 py-3"
          disabled={confirmSetup.isPending || !canContinue}
          onClick={continueToVerify}
        >
          Continue to verify
          <ArrowRightIcon size={16} weight="bold" />
        </Button>
      </div>
    </>
  );
}

function VercelConnectSection({ appId }: { appId: string }) {
  const { data, isLoading } = useAvailableVercelProjects(appId);
  const linkProject = useLinkVercelProject();
  const [selectedProjectId, setSelectedProjectId] = useState<string | undefined>(undefined);

  function handleLink() {
    if (selectedProjectId == null) return;
    linkProject.mutate({ applicationId: appId, vercelProjectId: selectedProjectId });
  }

  return (
    <section className="mt-8 border border-border-dim bg-surface-base p-6">
      <h2 className="font-mono text-sm font-bold uppercase tracking-widest text-text-primary">
        Connect a Vercel project
      </h2>
      <p className="mt-2 max-w-2xl text-sm text-text-secondary">
        Link a Vercel project you&apos;ve already authorized to this app. Autonoma manages the deployment-protection
        bypass secret automatically, so tests can reach the preview without a manual header.
      </p>

      {isLoading ? (
        <p className="mt-4 text-sm text-text-secondary">Loading Vercel projects...</p>
      ) : data?.linkedProject != null ? (
        <div className="mt-4 flex items-center gap-2 border-l-2 border-status-success bg-status-success/10 px-4 py-3">
          <CheckCircleIcon size={16} weight="fill" className="text-status-success" />
          <p className="text-sm text-text-secondary">
            Linked to <span className="font-mono text-text-primary">{data.linkedProject.name}</span>
          </p>
        </div>
      ) : data?.connected === false ? (
        <div className="mt-5 border border-primary-ink/40 bg-surface-void p-6">
          <div className="flex items-start gap-4">
            <div className="flex size-11 shrink-0 items-center justify-center border border-primary-ink/40 text-primary-ink">
              <VercelIcon />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-lg font-medium text-text-primary">Install the Autonoma Vercel integration</h3>
              <p className="mt-2 max-w-2xl text-sm text-text-secondary">
                You don&apos;t have the integration yet. We&apos;ll set you up on the Vercel marketplace and bring you
                right back here to finish setup.
              </p>
              {data.connectUrl != null ? (
                <a
                  href={data.connectUrl}
                  className={buttonVariants({
                    variant: "accent",
                    className: "mt-5 gap-2 px-6 py-3 font-mono text-sm font-bold uppercase",
                  })}
                  aria-label="onboarding-install-vercel-integration"
                >
                  Install the Autonoma Vercel integration
                  <ArrowRightIcon size={16} weight="bold" />
                </a>
              ) : (
                <p className="mt-4 font-mono text-2xs text-text-secondary">
                  The Vercel integration URL isn&apos;t configured on this environment.
                </p>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <div className="min-w-64">
            <Select value={selectedProjectId ?? ""} onValueChange={(value) => setSelectedProjectId(value ?? undefined)}>
              <SelectTrigger>
                <SelectValue
                  placeholder={data != null && data.projects.length === 0 ? "No unlinked projects" : "Select a project"}
                />
              </SelectTrigger>
              <SelectContent>
                {data?.projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            variant="accent"
            className="gap-2"
            disabled={selectedProjectId == null || linkProject.isPending}
            onClick={handleLink}
          >
            <LinkIcon size={14} weight="bold" />
            {linkProject.isPending ? "Linking..." : "Link project"}
          </Button>
          {data?.connectUrl != null && (
            <a
              href={data.connectUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 font-mono text-2xs text-text-secondary underline-offset-2 transition-colors hover:text-primary-ink hover:underline"
            >
              Connect a new Vercel project
              <ArrowSquareOutIcon size={12} />
            </a>
          )}
        </div>
      )}
    </section>
  );
}

function ProviderCard({
  active,
  disabled,
  icon,
  title,
  meta,
  onClick,
}: {
  active?: boolean;
  disabled?: boolean;
  icon: ReactNode;
  title: string;
  meta: string;
  onClick?: () => void;
}) {
  const className = active
    ? "border border-primary-ink bg-surface-base p-5 text-left"
    : disabled
      ? "border border-border-dim bg-surface-base p-5 text-left opacity-50"
      : "border border-border-dim bg-surface-base p-5 text-left transition-colors hover:border-border-highlight";

  const content = (
    <>
      <div className="text-text-secondary">{icon}</div>
      <h3 className="mt-5 text-lg font-medium text-text-primary">{title}</h3>
      <p className="mt-2 font-mono text-2xs uppercase tracking-widest text-text-secondary">
        {disabled ? "Soon" : meta}
      </p>
    </>
  );

  if (onClick == null || disabled) {
    return <div className={className}>{content}</div>;
  }

  return (
    <button type="button" className={className} onClick={onClick}>
      {content}
    </button>
  );
}

function VercelIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-6 fill-current">
      <path d="M12 4 22 20H2L12 4Z" />
    </svg>
  );
}

function SignalStep({ index, title, text }: { index: string; title: string; text: string }) {
  return (
    <div className="flex gap-4">
      <span className="font-mono text-sm text-primary-ink">{index}</span>
      <div>
        <p className="font-medium text-text-primary">{title}</p>
        <p className="mt-1 text-sm text-text-secondary">{text}</p>
      </div>
    </div>
  );
}

function buildPayloadPreview(applicationId: string) {
  return JSON.stringify(
    {
      applicationId,
      previewUrl: "https://your-preview.example.com",
      branch: "feature/example",
      sha: "abc1234",
      provider: "vercel",
    },
    undefined,
    2,
  );
}

function buildWorkflowSnippet({ applicationId, endpoint }: { applicationId: string; endpoint: string }) {
  return `# .github/workflows/autonoma-preview.yml
name: Autonoma preview signal

on:
  deployment_status:

jobs:
  notify:
    if: github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    steps:
      - name: Notify Autonoma
        env:
          AUTONOMA_SHARED_SECRET: \${{ secrets.AUTONOMA_SHARED_SECRET }}
          AUTONOMA_ENDPOINT: ${endpoint}
          AUTONOMA_APPLICATION_ID: ${applicationId}
          PREVIEW_URL: \${{ github.event.deployment_status.target_url }}
          PREVIEW_SHA: \${{ github.event.deployment.sha || github.sha }}
        run: |
          BODY=$(jq -nc \\
            --arg applicationId "$AUTONOMA_APPLICATION_ID" \\
            --arg previewUrl "$PREVIEW_URL" \\
            --arg sha "$PREVIEW_SHA" \\
            --arg provider "vercel" \\
            '{applicationId:$applicationId,previewUrl:$previewUrl,provider:$provider}
              + (if $sha == "" then {} else {sha:$sha} end)')
          SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$AUTONOMA_SHARED_SECRET" -hex | sed 's/^.* //')
          curl -sS -X POST "$AUTONOMA_ENDPOINT" \\
            -H "content-type: application/json" \\
            -H "x-signature: $SIG" \\
            --data "$BODY"`;
}
