import { Button } from "@autonoma/blacklight";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import { GitPullRequestIcon } from "@phosphor-icons/react/GitPullRequest";
import { KeyIcon } from "@phosphor-icons/react/Key";
import type { Icon } from "@phosphor-icons/react/lib";
import { RocketLaunchIcon } from "@phosphor-icons/react/RocketLaunch";
import { SealCheckIcon } from "@phosphor-icons/react/SealCheck";
import { getApiOrigin } from "lib/api-origin";
import { toastManager } from "lib/toast-manager";
import type { ReactNode } from "react";

/** Placeholders shown while the real values load, so the snippet stays copyable. */
const APPLICATION_ID_PLACEHOLDER = "APPLICATION_ID";
const SHARED_SECRET_PLACEHOLDER = "AUTONOMA_SHARED_SECRET";
const SECRET_NAME = "AUTONOMA_SHARED_SECRET";
const WORKFLOW_PATH = ".github/workflows/autonoma-preview.yml";

/** One hop of the "what the workflow actually does" diagram. */
interface FlowNode {
  label: string;
  detail: string;
}

const FLOW_NODES: FlowNode[] = [
  { label: "You push", detail: "A commit or pull request" },
  { label: "Your CI deploys", detail: "Your own pipeline, unchanged" },
  { label: "GitHub fires", detail: "A deployment_status event" },
  { label: "The workflow signs", detail: "HMAC over the payload" },
  { label: "Autonoma tests", detail: "Against that preview URL" },
];

/**
 * The four things the user has to do, in order. Steps 01-03 happen in their repo
 * and on GitHub, so Autonoma cannot observe them; step 04 is the one it watches,
 * and it is what gates Continue on the page.
 */
interface SetupStep {
  index: string;
  icon: Icon;
  title: string;
  body: string;
}

const SETUP_STEPS: SetupStep[] = [
  {
    index: "01",
    icon: KeyIcon,
    title: `Add ${SECRET_NAME} to your repository secrets`,
    body: "GitHub > Settings > Secrets and variables > Actions > New repository secret. The workflow signs every signal with it, and Autonoma rejects anything that isn't signed.",
  },
  {
    index: "02",
    icon: GitPullRequestIcon,
    title: `Commit ${WORKFLOW_PATH}`,
    body: "Copy the workflow on the right into that path on a branch, and open a pull request for it.",
  },
  {
    index: "03",
    icon: RocketLaunchIcon,
    title: "Push, and let your preview deploy",
    body: "The workflow only runs once GitHub reports a successful deployment, so your normal deploy has to finish first.",
  },
  {
    index: "04",
    icon: SealCheckIcon,
    title: "Wait for the signal to reach Autonoma",
    body: "The moment your first signed signal arrives we record the preview URL and unlock the next step. Keep this page open - it updates on its own.",
  },
];

export interface DeploymentSignalSetupProps {
  /** The app the signal is for. Undefined while it loads - the snippet shows a placeholder. */
  applicationId?: string;
  /** The signing secret. Undefined while it loads - the snippet shows a placeholder. */
  sharedSecret?: string;
}

/**
 * The custom (bring-your-own-deploys) setup panel: what the workflow does, the
 * ordered chore list, and the workflow to commit.
 *
 * Autonoma's GitHub App deliberately does not subscribe to `deployment_status` -
 * PreviewKit apps are deployed by Autonoma off pull-request and push events, so
 * only a customer running their own pipeline knows when a preview is actually
 * live. That is why this path needs a workflow in their repo rather than a
 * webhook subscription on ours.
 */
export function DeploymentSignalSetup({ applicationId, sharedSecret }: DeploymentSignalSetupProps) {
  const endpoint = `${getApiOrigin()}/v1/onboarding/deployment-signal`;
  const workflow = buildWorkflowSnippet({ applicationId: applicationId ?? APPLICATION_ID_PLACEHOLDER, endpoint });
  const secret = sharedSecret ?? SHARED_SECRET_PLACEHOLDER;

  function copyWorkflow() {
    void navigator.clipboard.writeText(workflow).then(() => {
      toastManager.add({ type: "success", title: "Workflow copied" });
    });
  }

  function copySecret() {
    void navigator.clipboard.writeText(secret).then(() => {
      toastManager.add({ type: "success", title: "Secret copied" });
    });
  }

  return (
    <>
      <section className="mt-8 border border-border-dim bg-surface-base">
        <div className="border-b border-border-dim bg-surface-raised px-5 py-4">
          <h2 className="font-mono text-sm font-bold uppercase tracking-widest text-text-primary">
            What the workflow does
          </h2>
        </div>
        <div className="p-6">
          <p className="max-w-3xl text-sm text-text-secondary">
            You keep deploying exactly as you do today. The workflow listens for GitHub's{" "}
            <span className="font-mono text-primary-ink">deployment_status</span> event, and when one reports success it
            signs the preview URL and posts it to Autonoma. That URL is what generated tests run against.
          </p>
          <SignalFlow />
        </div>
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(28rem,1fr)]">
        <section className="border border-border-dim bg-surface-base">
          <div className="border-b border-border-dim bg-surface-raised px-5 py-4">
            <h2 className="font-mono text-sm font-bold uppercase tracking-widest text-text-primary">
              What you need to do
            </h2>
          </div>
          <div className="space-y-5 p-6">
            {SETUP_STEPS.map((step) => (
              <SetupStepRow key={step.index} step={step}>
                {step.index === "01" ? (
                  <Button variant="outline" size="xs" className="mt-3 gap-2" onClick={copySecret}>
                    <CopyIcon size={13} />
                    Copy secret value
                  </Button>
                ) : undefined}
              </SetupStepRow>
            ))}
          </div>
        </section>

        <section className="border border-border-dim bg-surface-base">
          <div className="flex items-center justify-between border-b border-border-dim bg-surface-raised px-5 py-4">
            <h2 className="font-mono text-sm font-bold uppercase tracking-widest text-text-primary">{WORKFLOW_PATH}</h2>
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
    </>
  );
}

function SignalFlow() {
  return (
    <div className="mt-6 flex flex-col gap-2 lg:flex-row lg:items-stretch">
      {FLOW_NODES.map((node, index) => (
        <div key={node.label} className="flex items-center gap-2 lg:flex-1">
          <div className="flex-1 self-stretch border border-border-dim bg-surface-void px-3 py-3">
            <p className="font-mono text-4xs font-semibold uppercase tracking-widest text-primary-ink">
              {String(index + 1).padStart(2, "0")}
            </p>
            <p className="mt-1.5 text-2xs font-semibold leading-tight text-text-primary">{node.label}</p>
            <p className="mt-1 text-3xs leading-snug text-text-secondary">{node.detail}</p>
          </div>
          {index < FLOW_NODES.length - 1 ? (
            <ArrowRightIcon size={14} className="shrink-0 rotate-90 text-text-secondary lg:rotate-0" aria-hidden />
          ) : undefined}
        </div>
      ))}
    </div>
  );
}

function SetupStepRow({ step, children }: { step: SetupStep; children?: ReactNode }) {
  const StepIcon = step.icon;
  return (
    <div className="flex gap-4">
      <div className="flex flex-col items-center gap-2">
        <span className="font-mono text-sm text-primary-ink">{step.index}</span>
        <StepIcon size={15} weight="duotone" className="text-text-secondary" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="font-medium text-text-primary">{step.title}</p>
        <p className="mt-1 text-sm text-text-secondary">{step.body}</p>
        {children}
      </div>
    </div>
  );
}

function buildWorkflowSnippet({ applicationId, endpoint }: { applicationId: string; endpoint: string }) {
  return `# ${WORKFLOW_PATH}
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
          AUTONOMA_SHARED_SECRET: \${{ secrets.${SECRET_NAME} }}
          AUTONOMA_ENDPOINT: ${endpoint}
          AUTONOMA_APPLICATION_ID: ${applicationId}
          PREVIEW_URL: \${{ github.event.deployment_status.target_url }}
          PREVIEW_SHA: \${{ github.event.deployment.sha || github.sha }}
        run: |
          BODY=$(jq -nc \\
            --arg applicationId "$AUTONOMA_APPLICATION_ID" \\
            --arg previewUrl "$PREVIEW_URL" \\
            --arg sha "$PREVIEW_SHA" \\
            --arg provider "custom" \\
            '{applicationId:$applicationId,previewUrl:$previewUrl,provider:$provider}
              + (if $sha == "" then {} else {sha:$sha} end)')
          SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$AUTONOMA_SHARED_SECRET" -hex | sed 's/^.* //')
          curl -sS -X POST "$AUTONOMA_ENDPOINT" \\
            -H "content-type: application/json" \\
            -H "x-signature: $SIG" \\
            --data "$BODY"`;
}
