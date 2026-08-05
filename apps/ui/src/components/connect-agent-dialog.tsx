import {
  Button,
  Dialog,
  DialogBackdrop,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@autonoma/blacklight";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import { InfoIcon } from "@phosphor-icons/react/Info";
import { getApiOrigin } from "lib/api-origin";
import { demoModalStore } from "lib/demo-modal-store";
import { useCreateAgentPairing } from "lib/onboarding/onboarding-api";
import { useCreateApiKey } from "lib/query/api-keys.queries";
import { useActiveOrg } from "lib/query/auth.queries";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { agentMcpPrompt } from "./agent-mcp-prompt";
import {
  AGENT_TABS,
  remoteAgentKeyName,
  stepsWithFallback,
  type AgentStep,
  type InstallSnippetInput,
} from "./connect-agent-snippets";

/** Public docs page for connecting a coding agent - install, pairing, and what the tools do. */
export const MCP_DOCS_URL = "https://docs.autonoma.app/mcp/";

/**
 * MCP server name every install snippet registers. One name because there is one server:
 * it carries the onboarding tools and the pull-request debugging tools alike, and which
 * job an agent is doing is decided by the prompt it is started on, not by what it connected
 * to. Example prompts still say it verbatim - see {@link NameTheMcpNote}.
 */
export const MCP_SERVER_NAME = "autonoma";

/**
 * What the dialog says above the install steps on a surface where the user has usually
 * connected this server already, so the copy leads with "the same one" instead of
 * introducing it from scratch.
 */
export const AGENT_DIALOG_DESCRIPTION =
  "Autonoma's MCP - the same one that configures previews and debugs pull requests. Run this in your project to connect it and start your agent on the job. If you already have it installed, running it again is harmless.";

/**
 * Resolve the Autonoma MCP endpoint the user's coding agent connects to. We point
 * at the dedicated API host (`api.<app-host>`), NOT the app origin: the app host
 * (autonoma.app) sits behind CloudFront, whose WAF/buffering can 403 or mangle
 * large request bodies (the whole `apply_config` document, a `set_secret` value)
 * and interfere with the MCP's streaming HTTP; the `api.` host is direct to the
 * ALB, off CloudFront. The OAuth handshake follows: the protected-resource
 * metadata advertises this `api.` origin as its `resource` (MCP_RESOURCE_URL on
 * the API), so a strict client's resource-match check passes; the authorization
 * server itself stays on APP_URL (the app origin), where the 401 challenge and
 * discovery are anchored. Localhost and per-PR previews reach the API cross-origin at VITE_API_URL.
 */
export function mcpEndpointUrl(): string {
  return `${getApiOrigin()}/v1/mcp`;
}

export interface ConnectAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  /**
   * The sentence the agent is started on - e.g. "use the autonoma MCP to configure my
   * preview". The pairing code is appended for you when this dialog pins an app.
   */
  instruction: string;
  /**
   * Pin this application to the agent with a pairing code, for the onboarding job: a code is
   * minted while the dialog is open and shown above the steps. Omit it for work on an app that
   * is already live, where the agent identifies the app from the repo it is sitting in.
   */
  applicationId?: string;
  /** What the agent can do once connected, shown under the launch step. */
  capabilities?: ReactNode;
}

/**
 * The one "connect your coding agent to Autonoma" dialog: per-client install snippets, the
 * prompt to hand over, and a docs link.
 *
 * There is one server and one installation, so there is one dialog. The two jobs it does -
 * onboarding an app, and debugging a pull request Autonoma flagged - differ only in what the
 * caller asks for: the `instruction` the agent is started on, and whether an `applicationId`
 * is being pinned with a pairing code. Someone who connected it during onboarding is already
 * connected for the debugging, which is the point.
 */
export function ConnectAgentDialog({
  open,
  onOpenChange,
  title,
  description,
  instruction,
  applicationId,
  capabilities,
}: ConnectAgentDialogProps) {
  // Connecting a coding agent is an MCP entry point, and the demo org is locked out of the
  // MCP entirely (see the API-side gates). So in the demo, never open this dialog - bounce to
  // the "sign up to continue" modal instead, the same conversion moment as any blocked write.
  const isDemo = useActiveOrg().data?.isDemo === true;
  useEffect(() => {
    if (open && isDemo) {
      demoModalStore.open();
      onOpenChange(false);
    }
  }, [open, isDemo, onOpenChange]);

  const createPairing = useCreateAgentPairing();
  // Mint on open, and only once per opening: codes are single-use and short-lived, so
  // a fresh one per visit is right, but a re-render (or React's dev double-mount) must
  // not churn the code the user is reading. Cleared on close so reopening re-mints.
  // In the demo we bounce to the sign-up modal above, so never mint - the pairing write
  // would just be rejected anyway.
  const mintedFor = useRef<string | undefined>(undefined);
  const mintPairing = createPairing.mutate;
  useEffect(() => {
    if (!open || isDemo || applicationId == null) {
      mintedFor.current = undefined;
      return;
    }
    if (mintedFor.current === applicationId) return;
    mintedFor.current = applicationId;
    mintPairing({ applicationId });
  }, [open, isDemo, applicationId, mintPairing]);

  if (isDemo) return null;

  const code = createPairing.data?.code;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogBackdrop />
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <ConnectAgentInstall
            prompt={agentMcpPrompt(instruction, code)}
            capabilities={capabilities}
            pairing={
              applicationId != null && (
                <AgentPairingCode
                  code={code}
                  pending={createPairing.isPending}
                  error={createPairing.isError}
                  onRetry={() => mintPairing({ applicationId })}
                />
              )
            }
          />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The pairing code block shown inside the connect-agent dialog (or a skeleton / retry while
 * it mints). Read-only: the code is already inside the command below it, so there is
 * nothing here worth copying on its own.
 */
function AgentPairingCode({
  code,
  pending,
  error,
  onRetry,
}: {
  code?: string;
  pending: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  if (pending) return <Skeleton className="h-16 w-full" />;
  if (error || code == null) {
    return (
      <div className="flex flex-col items-center gap-2 border border-status-critical/40 bg-surface-raised p-4">
        <span className="text-2xs text-status-critical">Couldn't generate a pairing code.</span>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-1 border border-border-dim bg-surface-raised p-4">
      <span className="text-2xs uppercase tracking-wide text-text-secondary">Pairing code</span>
      <span className="font-mono text-3xl tracking-[0.3em] text-primary">{code}</span>
    </div>
  );
}

export interface ConnectAgentInstallProps {
  /** The sentence the agent is started on, pairing code already appended. */
  prompt: string;
  /** What the agent can do once connected, shown under the launch step. */
  capabilities?: ReactNode;
  /** Optional block above the steps (e.g. the onboarding pairing code). */
  pairing?: ReactNode;
}

/**
 * The install-instructions body of the connect-agent flow: pick your client, then run what
 * it shows you - one terminal line for Claude Code, a config entry plus a prompt for the
 * editor clients.
 *
 * Authorization is deliberately not a step of its own. It used to be, as prose sitting
 * directly under the command, and it was skipped near-universally: people ran the box and
 * moved on, then read the resulting empty tool list as a broken integration. So the
 * `mcp login` call lives inside the line they were going to run anyway.
 *
 * Rendered inside {@link ConnectAgentDialog} and, for the MCP-first onboarding,
 * directly on the page (no dialog) - so `AGENT_TABS` stays a single source of truth
 * across both surfaces.
 */
export function ConnectAgentInstall({ prompt, capabilities, pairing }: ConnectAgentInstallProps) {
  const createApiKey = useCreateApiKey();
  // One key per visit, not per copy: a user who copies two blocks wanted one credential,
  // and a key list with a row per click is one nobody can audit.
  //
  // Holds the PROMISE rather than the resolved key. Caching the key would only dedupe
  // copies made after the first mint returns; two clicks inside that round-trip would both
  // read an empty cache and create a live credential each.
  const minting = useRef<Promise<string> | undefined>(undefined);
  const snippetInput: InstallSnippetInput = {
    url: mcpEndpointUrl(),
    serverName: MCP_SERVER_NAME,
    prompt,
    mintKey: () => {
      minting.current ??= createApiKey
        .mutateAsync({ name: remoteAgentKeyName(MCP_SERVER_NAME) })
        .then((created) => created.key)
        // A failed mint must not poison the ref, or every later copy replays the failure
        // against a key that was never created.
        .catch((err: unknown) => {
          minting.current = undefined;
          throw err;
        });
      return minting.current;
    },
  };
  return (
    <div className="flex flex-col gap-7">
      {pairing}

      {/* One Tabs around both steps, not one per step: the client choice decides how you
          install AND how you launch, so picking "Cursor" at the top must carry down. */}
      <Tabs defaultValue="claude">
        <TabsList>
          {AGENT_TABS.map((tab) => (
            <TabsTrigger key={tab.id} value={tab.id}>
              {tab.hint == null ? (
                tab.label
              ) : (
                <Tooltip>
                  <TooltipTrigger render={<span className="flex items-center gap-1.5" />}>
                    {tab.label}
                    <InfoIcon weight="bold" className="size-3 text-text-secondary" />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-72">{tab.hint}</TooltipContent>
                </Tooltip>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
        {AGENT_TABS.map((tab) => (
          <TabsContent key={tab.id} value={tab.id} className="flex flex-col gap-7">
            <TabSteps steps={stepsWithFallback(tab, snippetInput)} capabilities={capabilities} />
          </TabsContent>
        ))}
      </Tabs>

      <a
        href={MCP_DOCS_URL}
        target="_blank"
        rel="noreferrer"
        className="inline-flex w-fit items-center gap-1.5 text-2xs text-primary hover:underline"
      >
        <ArrowSquareOutIcon weight="bold" />
        Learn more about configuring with a coding agent
      </a>
    </div>
  );
}

/**
 * A client's steps, with the capabilities blurb under the last one. Numbered only when
 * there is more than one - a lone "1" in a box promises a step 2 that never comes.
 */
function TabSteps({ steps, capabilities }: { steps: AgentStep[]; capabilities?: ReactNode }) {
  return (
    <>
      {steps.map((step, position) => (
        <Step key={step.title} index={steps.length > 1 ? position + 1 : undefined} title={step.title}>
          <p className="text-2xs leading-relaxed text-text-secondary">{step.instruction}</p>
          {step.location != null && <p className="font-mono text-2xs text-text-secondary">{step.location}</p>}
          <CodeBlock code={step.code} resolveCopyText={step.resolveCopyText} />
          {capabilities != null && position === steps.length - 1 && (
            <p className="text-2xs leading-relaxed text-text-secondary">{capabilities}</p>
          )}
        </Step>
      ))}
    </>
  );
}

/** One step of the connect flow: an optional boxed index, a title, and its body. */
function Step({ index, title, children }: { index?: number; title: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      {index != null && (
        <span className="flex size-5 shrink-0 items-center justify-center border border-border-mid font-mono text-3xs text-text-secondary">
          {index}
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <h3 className="font-mono text-2xs font-bold uppercase tracking-widest text-text-primary">{title}</h3>
        {children}
      </div>
    </div>
  );
}

function CodeBlock({ code, resolveCopyText }: { code: string; resolveCopyText?: () => Promise<string> }) {
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);

  function copy() {
    if (copying) return;
    // `navigator.clipboard` is undefined in insecure contexts, and the write can reject
    // (permissions, unfocused document) - handle both so the failure logs instead of
    // surfacing as an unhandled rejection, and the check stays false.
    if (navigator.clipboard == null) {
      console.warn("Clipboard API unavailable; cannot copy the install command");
      return;
    }
    // Resolved per click rather than up front: for the remote-agent block this is what
    // creates the API key, so a tab nobody copies from never mints one.
    setCopying(true);
    const text = resolveCopyText != null ? resolveCopyText() : Promise.resolve(code);
    text
      .then((resolved) => navigator.clipboard.writeText(resolved))
      .then(() => setCopied(true))
      .catch((err) => console.warn("Failed to copy the install command", err))
      .finally(() => setCopying(false));
  }

  return (
    <div className="relative">
      {/* Wraps rather than scrolls: the command runs past the panel width, and a command
          whose tail is off-screen reads as broken - which is the opposite of the reassurance
          someone needs before pasting it into a terminal. Soft wraps are not copied, so the
          clipboard still gets the exact command. */}
      <pre className="whitespace-pre-wrap border border-border-dim bg-surface-void p-3 pr-11 font-mono text-2xs text-text-primary [overflow-wrap:anywhere]">
        {code}
      </pre>
      <Button
        variant="ghost"
        size="icon-xs"
        className="absolute right-2 top-2 bg-surface-void"
        onClick={copy}
        disabled={copying}
        aria-label={copying ? "Copying" : "Copy"}
      >
        {copied ? <CheckIcon className="text-status-success" /> : <CopyIcon />}
      </Button>
    </div>
  );
}
