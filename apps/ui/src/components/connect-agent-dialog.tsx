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
import { env } from "env";
import { useState, type ReactNode } from "react";

/** The two Autonoma MCP surfaces, addressed by their `/v1/mcp/<path>` suffix. */
export type McpEndpoint = "onboarding" | "debug";

/** Public docs page for the debug MCP (connect an agent to read/fix a PR's preview). */
export const DEBUG_MCP_DOCS_URL = "https://docs.autonoma.app/mcp/";

/**
 * Resolve the Autonoma MCP endpoint the user's coding agent connects to. We point
 * at the dedicated API host (`api.<app-host>`), NOT the app origin: the app host
 * (autonoma.app) sits behind CloudFront, whose WAF/buffering can 403 or mangle
 * large request bodies (the whole `apply_config` document, a `set_secret` value)
 * and interfere with the MCP's streaming HTTP; the `api.` host is direct to the
 * ALB, off CloudFront. The OAuth handshake is unaffected - the 401 challenge and
 * discovery are anchored at APP_URL (the app origin) and the bearer token is
 * verified host-agnostically, so only the data plane moves off CloudFront.
 * Localhost and per-PR previews reach the API cross-origin at VITE_API_URL.
 */
export function mcpEndpointUrl(path: McpEndpoint): string {
  const isPreview = window.location.hostname.endsWith(`.preview.${env.VITE_INTERNAL_DOMAIN}`);
  const isLocalhost = window.location.hostname === "localhost";
  const base = isPreview || isLocalhost ? env.VITE_API_URL : `https://api.${window.location.hostname}`;
  return `${base}/v1/mcp/${path}`;
}

interface AgentTab {
  id: string;
  label: string;
  /** How to install the MCP for this client, given the endpoint URL + server name. */
  snippet: (url: string, serverName: string) => string;
  /** File / place the snippet goes (shown above the code). */
  location?: string;
}

const AGENT_TABS: AgentTab[] = [
  {
    id: "claude",
    label: "Claude Code",
    snippet: (url, serverName) => `claude mcp add --transport http ${serverName} ${url}`,
  },
  {
    id: "cursor",
    label: "Cursor",
    location: "~/.cursor/mcp.json",
    snippet: (url, serverName) => JSON.stringify({ mcpServers: { [serverName]: { url } } }, null, 2),
  },
  {
    id: "windsurf",
    label: "Windsurf",
    location: "~/.codeium/windsurf/mcp_config.json",
    snippet: (url, serverName) => JSON.stringify({ mcpServers: { [serverName]: { serverUrl: url } } }, null, 2),
  },
  {
    id: "other",
    label: "Other",
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
  const url = mcpEndpointUrl(endpoint);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogBackdrop />
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-6">
          {pairing}
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
                {tab.location != null && <p className="font-mono text-2xs text-text-secondary">{tab.location}</p>}
                <CopyableCode code={tab.snippet(url, serverName)} />
              </TabsContent>
            ))}
          </Tabs>
          <p className="text-2xs text-text-secondary">{tellAgent}</p>
          <a
            href={docsUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex w-fit items-center gap-1.5 text-2xs text-primary hover:underline"
          >
            <ArrowSquareOutIcon weight="bold" />
            Learn more about configuring with a coding agent
          </a>
        </DialogBody>
      </DialogContent>
    </Dialog>
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
