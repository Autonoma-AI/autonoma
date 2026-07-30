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
} from "@autonoma/blacklight";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import { getApiOrigin } from "lib/api-origin";
import { demoModalStore } from "lib/demo-modal-store";
import { useActiveOrg } from "lib/query/auth.queries";
import { useEffect, useState, type ReactNode } from "react";

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

interface AgentTab {
  id: string;
  label: string;
  /** How to install the MCP for this client, given the endpoint URL + server name. */
  snippet: (url: string, serverName: string) => string;
  /** File / place the snippet goes (shown above the code). */
  location?: string;
  /** What the user does with the snippet, and when - installing is a step BEFORE the agent runs. */
  instruction: string;
}

const AGENT_TABS: AgentTab[] = [
  {
    id: "claude",
    label: "Claude Code",
    instruction: "Run this in your terminal first, before you open Claude Code. Already open? Quit and reopen it.",
    snippet: (url, serverName) => `claude mcp add --transport http ${serverName} ${url}`,
  },
  {
    id: "cursor",
    label: "Cursor",
    location: "~/.cursor/mcp.json",
    instruction: "Add this to your Cursor MCP config, then restart Cursor.",
    snippet: (url, serverName) => JSON.stringify({ mcpServers: { [serverName]: { url } } }, null, 2),
  },
  {
    id: "windsurf",
    label: "Windsurf",
    location: "~/.codeium/windsurf/mcp_config.json",
    instruction: "Add this to your Windsurf MCP config, then refresh MCP servers in Cascade.",
    snippet: (url, serverName) => JSON.stringify({ mcpServers: { [serverName]: { serverUrl: url } } }, null, 2),
  },
  {
    id: "other",
    label: "Other",
    instruction: "Run this in your terminal before you open your agent, or add the equivalent entry to its MCP config.",
    snippet: (url) => `npx -y mcp-remote ${url}`,
  },
];

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
  /** The "Then tell your agent: ..." guidance under the install tabs. */
  tellAgent: ReactNode;
  /** Optional block above the install tabs (e.g. the onboarding pairing code). */
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
  tellAgent,
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
            tellAgent={tellAgent}
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
  /** The "Then tell your agent: ..." guidance under the install tabs. */
  tellAgent: ReactNode;
  /** Optional block above the install tabs (e.g. the onboarding pairing code). */
  pairing?: ReactNode;
}

/**
 * The install-instructions body of the connect-agent flow, as three ordered steps:
 * install the server, authorize it, then talk to the agent. The order is the whole
 * point - installing happens in a terminal before the agent is running, and the
 * OAuth approval is a step people miss and then report the tools as broken - so the
 * pairing block and the "tell your agent" line land last, not first.
 *
 * Rendered inside {@link ConnectAgentDialog} and, for the MCP-first onboarding,
 * directly on the page (no dialog) - so `AGENT_TABS` stays a single source of truth
 * across both surfaces.
 */
export function ConnectAgentInstall({ serverName, endpoint, docsUrl, tellAgent, pairing }: ConnectAgentInstallProps) {
  const url = mcpEndpointUrl(endpoint);
  return (
    <div className="flex flex-col gap-7">
      <Step index={1} title="Install the Autonoma MCP">
        <Tabs defaultValue="claude">
          <TabsList>
            {AGENT_TABS.map((tab) => (
              <TabsTrigger key={tab.id} value={tab.id}>
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>
          {AGENT_TABS.map((tab) => (
            <TabsContent key={tab.id} value={tab.id} className="flex flex-col gap-2">
              <p className="text-2xs leading-relaxed text-text-secondary">{tab.instruction}</p>
              {tab.location != null && <p className="font-mono text-2xs text-text-secondary">{tab.location}</p>}
              <CopyableCode code={tab.snippet(url, serverName)} />
            </TabsContent>
          ))}
        </Tabs>
      </Step>

      <Step index={2} title="Authorize Autonoma">
        <p className="text-2xs leading-relaxed text-text-secondary">
          The first time your agent calls an Autonoma tool it opens a browser to sign in - approve it, or every tool
          fails. You can also do it up front: in Claude Code run{" "}
          <span className="font-mono text-text-primary">/mcp</span> and authenticate{" "}
          <span className="font-mono text-text-primary">{serverName}</span>; in Cursor or Windsurf, sign in from their
          MCP settings.
        </p>
      </Step>

      <Step index={3} title={pairing != null ? "Pair your app" : "Ask your agent"}>
        {pairing}
        <p className="text-2xs leading-relaxed text-text-secondary">{tellAgent}</p>
      </Step>

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

/** One numbered step of the connect flow: a boxed index, a title, and its body. */
function Step({ index, title, children }: { index: number; title: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="flex size-5 shrink-0 items-center justify-center border border-border-mid font-mono text-3xs text-text-secondary">
        {index}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <h3 className="font-mono text-2xs font-bold uppercase tracking-widest text-text-primary">{title}</h3>
        {children}
      </div>
    </div>
  );
}

function CopyableCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  function copy() {
    void navigator.clipboard.writeText(code).then(() => setCopied(true));
  }

  return (
    <div className="relative">
      <pre className="overflow-x-auto border border-border-dim bg-surface-void p-3 pr-11 font-mono text-2xs text-text-primary">
        {code}
      </pre>
      <Button
        variant="ghost"
        size="icon-xs"
        className="absolute right-2 top-2 bg-surface-void"
        onClick={copy}
        aria-label="Copy"
      >
        {copied ? <CheckIcon className="text-status-success" /> : <CopyIcon />}
      </Button>
    </div>
  );
}
