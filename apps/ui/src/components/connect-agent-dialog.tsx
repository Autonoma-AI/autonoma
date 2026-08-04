import {
  Button,
  Dialog,
  DialogBackdrop,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
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
import { useCreateApiKey } from "lib/query/api-keys.queries";
import { useActiveOrg } from "lib/query/auth.queries";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AGENT_TABS,
  remoteAgentKeyName,
  stepsWithFallback,
  type AgentStep,
  type InstallSnippetInput,
} from "./connect-agent-snippets";

/** The two Autonoma MCP surfaces, addressed by their `/v1/mcp/<path>` suffix. */
export type McpEndpoint = "onboarding" | "debug";

/** Public docs page for the debug MCP (connect an agent to read/fix a PR's preview). */
export const DEBUG_MCP_DOCS_URL = "https://docs.autonoma.app/mcp/";

/**
 * MCP server name the debug install snippets register (keyed by the repo the agent sits
 * in - no pairing code). Every example prompt must say it verbatim: a user who onboarded
 * also has `autonoma-onboarding` connected, and "the Autonoma MCP" names both.
 */
export const DEBUG_MCP_SERVER_NAME = "autonoma";

/** MCP server name the onboarding install snippets register (pins an app via a pairing code). */
export const ONBOARDING_MCP_SERVER_NAME = "autonoma-onboarding";

/** Public docs page for the agentic onboarding flow (install, pairing, tools, secrets). */
export const ONBOARDING_MCP_DOCS_URL = "https://docs.autonoma.app/mcp/configure-preview";

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
export function mcpEndpointUrl(path: McpEndpoint): string {
  return `${getApiOrigin()}/v1/mcp/${path}`;
}

export interface ConnectAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  /** MCP server name the install snippets register (e.g. "autonoma", "autonoma-onboarding"). */
  serverName: string;
  endpoint: McpEndpoint;
  /** Public docs page for this MCP flow. */
  docsUrl: string;
  /** The sentence the agent is started on, pairing code already appended. */
  prompt: string;
  /** What the agent can do once connected, shown under the launch step. */
  capabilities?: ReactNode;
  /** Optional block above the steps (e.g. the onboarding pairing code). */
  pairing?: ReactNode;
}

/**
 * The shared "connect your coding agent to the Autonoma MCP" dialog: per-client
 * install snippets, a docs link, and an optional pairing block. Both the
 * onboarding flow (which pins an app with a pairing code) and the preview
 * settings (debug MCP, keyed by the repo the agent already sits in - no pairing)
 * render it.
 */
export function ConnectAgentDialog({
  open,
  onOpenChange,
  title,
  description,
  serverName,
  endpoint,
  docsUrl,
  prompt,
  capabilities,
  pairing,
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
  if (isDemo) return null;

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
            serverName={serverName}
            endpoint={endpoint}
            docsUrl={docsUrl}
            prompt={prompt}
            capabilities={capabilities}
            pairing={pairing}
          />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

export interface ConnectAgentInstallProps {
  /** MCP server name the install snippets register (e.g. "autonoma", "autonoma-onboarding"). */
  serverName: string;
  endpoint: McpEndpoint;
  /** Public docs page for this MCP flow. */
  docsUrl: string;
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
export function ConnectAgentInstall({
  serverName,
  endpoint,
  docsUrl,
  prompt,
  capabilities,
  pairing,
}: ConnectAgentInstallProps) {
  const createApiKey = useCreateApiKey();
  // One key per visit, not per copy: a user who copies two blocks wanted one credential,
  // and a key list with a row per click is one nobody can audit.
  //
  // Holds the PROMISE rather than the resolved key. Caching the key would only dedupe
  // copies made after the first mint returns; two clicks inside that round-trip would both
  // read an empty cache and create a live credential each.
  const minting = useRef<Promise<string> | undefined>(undefined);
  const snippetInput: InstallSnippetInput = {
    url: mcpEndpointUrl(endpoint),
    serverName,
    prompt,
    mintKey: () => {
      minting.current ??= createApiKey
        .mutateAsync({ name: remoteAgentKeyName(serverName) })
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
        href={docsUrl}
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
