import { Button } from "@autonoma/blacklight";
import {
  buildDeploymentSignalWorkflow,
  DEPLOYMENT_SIGNAL_SECRET_NAME,
  DEPLOYMENT_SIGNAL_WORKFLOW_PATH,
} from "@autonoma/types";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import { GitPullRequestIcon } from "@phosphor-icons/react/GitPullRequest";
import { KeyIcon } from "@phosphor-icons/react/Key";
import type { Icon } from "@phosphor-icons/react/lib";
import { RocketLaunchIcon } from "@phosphor-icons/react/RocketLaunch";
import { getApiOrigin } from "lib/api-origin";
import { toastManager } from "lib/toast-manager";
import type { ReactNode } from "react";
import { ConnectDeploysWithAgent } from "./connect-deploys-with-agent";

/** Placeholders shown while the real values load, so the snippet stays copyable. */
const APPLICATION_ID_PLACEHOLDER = "APPLICATION_ID";
const SHARED_SECRET_PLACEHOLDER = "AUTONOMA_SHARED_SECRET";
const SECRET_NAME = DEPLOYMENT_SIGNAL_SECRET_NAME;
const WORKFLOW_PATH = DEPLOYMENT_SIGNAL_WORKFLOW_PATH;

/** One hop of the "what the workflow actually does" diagram. */
interface FlowNode {
  label: string;
  detail: string;
}

// Describes the contract, not the sample workflow: the YAML below is one way to
// reach step 04, so naming `deployment_status` here would contradict the copy
// telling people to trigger it however their pipeline works.
const FLOW_NODES: FlowNode[] = [
  { label: "You push", detail: "A commit or pull request" },
  { label: "Your CI deploys", detail: "Your own pipeline, unchanged" },
  { label: "A preview goes live", detail: "Wherever you host it" },
  { label: "Your pipeline signals", detail: "A signed POST to Autonoma" },
  { label: "Autonoma tests", detail: "Against that preview URL" },
];

/**
 * The three things the user does by hand. All of them happen in their repo and on
 * GitHub, so Autonoma cannot observe any of them - the one step it CAN observe is
 * the signal arriving, which is its own live panel rather than a fourth bullet.
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
    title: "Make the signed call from your pipeline",
    body: `Copy the template on the right - it commits as ${WORKFLOW_PATH} if your host reports deployments to GitHub. If it doesn't, make the same signed call from whatever step knows a preview is live.`,
  },
  {
    index: "03",
    icon: RocketLaunchIcon,
    title: "Push, and let your preview deploy",
    body: "Autonoma is only signalled after a preview is actually live, so your normal deploy has to finish first.",
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
  const resolvedApplicationId = applicationId ?? APPLICATION_ID_PLACEHOLDER;
  const workflow = buildDeploymentSignalWorkflow({ applicationId: resolvedApplicationId, endpoint });
  const secret = sharedSecret ?? SHARED_SECRET_PLACEHOLDER;

  // The clipboard carries the brief as well as the YAML: the workflow is a
  // starting point for one common setup, and the person pasting it is usually
  // pasting into a coding agent. Handing over only the file invites it to be
  // committed verbatim into a pipeline that never emits `deployment_status`.
  function copyWorkflow() {
    const payload = `${buildTemplateBrief({ applicationId: resolvedApplicationId, endpoint })}\n${workflow}`;
    void navigator.clipboard.writeText(payload).then(() => {
      toastManager.add({ type: "success", title: "Workflow copied", description: "Includes notes for your agent" });
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
            You keep deploying exactly as you do today. Autonoma needs one signed HTTP call whenever a preview goes
            live, telling it which URL to open - that URL is what generated tests run against.
          </p>
          <p className="mt-3 max-w-3xl text-sm text-text-secondary">
            The workflow on the right is <span className="text-text-primary">one way</span> to make that call: it hangs
            off GitHub's <span className="font-mono text-primary-ink">deployment_status</span> event, which suits hosts
            that report deployments back to GitHub. If yours doesn't, make the same call from whatever step in your
            pipeline knows a preview is live.
          </p>
          <SignalFlow />
        </div>
      </section>

      {applicationId != null ? (
        <section className="mt-6 flex flex-wrap items-center justify-between gap-4 border border-primary-ink/30 bg-surface-base p-5">
          <div className="min-w-0">
            <h2 className="text-lg font-medium text-text-primary">Let a coding agent do it</h2>
            <p className="mt-1 max-w-2xl text-sm text-text-secondary">
              Fitting this to your pipeline means reading how the project actually deploys. An agent already sitting in
              your repo can do that, open a pull request with the change, and confirm the signal reached us.
            </p>
          </div>
          <ConnectDeploysWithAgent applicationId={applicationId} />
        </section>
      ) : undefined}

      {/* The agent panel above is the lead path now, so the hand-rolled steps and
          the 60-line workflow open on demand. Left expanded they made the page
          long enough that the live signal state scrolled out of sight. */}
      <details className="group mt-6">
        <summary className="flex cursor-pointer list-none items-center gap-2 border border-border-dim bg-surface-base px-5 py-4 font-mono text-sm font-bold uppercase tracking-widest text-text-primary transition-colors hover:border-border-highlight">
          <CaretRightIcon size={14} weight="bold" className="transition-transform group-open:rotate-90" />
          Or do it yourself
        </summary>
        <div className="mt-2 grid gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(28rem,1fr)]">
          <section className="border border-border-dim bg-surface-base">
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
              <div className="flex items-center gap-2.5">
                <h2 className="font-mono text-sm font-bold uppercase tracking-widest text-text-primary">
                  {WORKFLOW_PATH}
                </h2>
                <span className="border border-border-mid px-1.5 py-0.5 font-mono text-4xs uppercase tracking-widest text-text-secondary">
                  Template
                </span>
              </div>
              <Button variant="outline" size="xs" className="gap-2" onClick={copyWorkflow}>
                <CopyIcon size={13} />
                Copy
              </Button>
            </div>
            <p className="border-b border-border-dim px-5 py-3 text-2xs leading-snug text-text-secondary">
              Copying also puts a short brief on your clipboard - the signed call Autonoma needs and what to adapt - so
              you can hand the whole thing to a coding agent and let it fit this to your pipeline.
            </p>
            <pre className="max-h-[34rem] overflow-auto p-6 font-mono text-2xs leading-relaxed text-text-primary">
              {workflow}
            </pre>
          </section>
        </div>
      </details>
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

/**
 * The comment block prepended to the copied workflow. It is written to be read by
 * a coding agent as much as by a person: it states the contract Autonoma actually
 * needs (a signed POST) and the fact that `deployment_status` is one way to reach
 * it, not the requirement - so an agent adapts it to the pipeline in front of it
 * instead of committing a workflow that will never fire.
 */
function buildTemplateBrief({ applicationId, endpoint }: { applicationId: string; endpoint: string }) {
  return `# ---------------------------------------------------------------------------
# Autonoma preview signal - TEMPLATE. Adapt it; do not assume it drops in.
#
# The only thing Autonoma actually requires is ONE HTTP call, made whenever a
# preview finishes deploying:
#
#   POST ${endpoint}
#   x-signature: <hex HMAC-SHA256 of the exact raw body, keyed with AUTONOMA_SHARED_SECRET>
#   body: {
#     "applicationId": "${applicationId}",   // required
#     "previewUrl":    "<url Autonoma should open>",  // required
#     "branch":        "<branch>",   // send WITH prNumber to get per-PR reviews
#     "prNumber":      <number>,     // send WITH branch; omit both for a main-branch deploy
#     "sdkUrl":        "<url>",      // only if the Autonoma SDK is on another origin
#     "sha":           "<commit>",   // optional
#     "provider":      "custom"      // optional
#   }
#
# The workflow below is one way to make that call - it hangs off GitHub's
# deployment_status event, which suits hosts that report deployments to GitHub.
# If your pipeline does not emit deployment_status, do NOT bend it to fit: make
# the same signed call from whatever step in your pipeline knows a preview is
# live (a deploy job, your host's webhook, a post-deploy script).
#
# Two things to get right whichever way you trigger it:
#   1. Sign the EXACT bytes you send. Re-serializing the JSON changes the digest.
#   2. If one pull request deploys several services (frontend, API, database),
#      signal only the one Autonoma should browse. Every signal overwrites the
#      previous preview URL, so signalling all of them means the last deploy to
#      finish wins - and that may be your API rather than your frontend.
# ---------------------------------------------------------------------------`;
}
