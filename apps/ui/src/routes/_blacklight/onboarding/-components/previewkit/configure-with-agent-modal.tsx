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
} from "@autonoma/blacklight";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import { RobotIcon } from "@phosphor-icons/react/Robot";
import { env } from "env";
import { useCreateAgentPairing } from "lib/onboarding/onboarding-api";
import { useState } from "react";

/** The onboarding MCP endpoint the user's coding agent connects to. */
const MCP_URL = `${env.VITE_API_URL}/v1/mcp/onboarding`;
const MCP_SERVER_NAME = "autonoma-onboarding";
/** Public docs page explaining the agentic onboarding flow (install, pairing, tools, secrets). */
const DOCS_URL = "https://docs.autonoma.app/mcp/configure-preview";

interface AgentTab {
  id: string;
  label: string;
  /** How to install the MCP for this client, given the endpoint URL. */
  snippet: (url: string) => string;
  /** File / place the snippet goes (shown above the code). */
  location?: string;
}

const AGENT_TABS: AgentTab[] = [
  {
    id: "claude",
    label: "Claude Code",
    snippet: (url) => `claude mcp add --transport http ${MCP_SERVER_NAME} ${url}`,
  },
  {
    id: "cursor",
    label: "Cursor",
    location: "~/.cursor/mcp.json",
    snippet: (url) => JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { url } } }, null, 2),
  },
  {
    id: "windsurf",
    label: "Windsurf",
    location: "~/.codeium/windsurf/mcp_config.json",
    snippet: (url) => JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { serverUrl: url } } }, null, 2),
  },
  {
    id: "other",
    label: "Other",
    snippet: (url) => `npx -y mcp-remote ${url}`,
  },
];

/**
 * Entry point for agentic onboarding: a button that mints a short-lived pairing
 * code and opens a modal showing, per coding agent, how to install the onboarding
 * MCP - plus the code the user hands to their agent ("configure with code ...").
 * The agent authenticates via OAuth on first use; the code pins this app.
 */
export function ConfigureWithAgentModal({ applicationId }: { applicationId: string }) {
  const [open, setOpen] = useState(false);
  const createPairing = useCreateAgentPairing();

  function openAndPair() {
    setOpen(true);
    createPairing.mutate({ applicationId });
  }

  const code = createPairing.data?.code;

  return (
    <>
      <Button variant="outline" onClick={openAndPair} disabled={createPairing.isPending}>
        <RobotIcon weight="bold" />
        Configure with coding agent
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogBackdrop />
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Configure with a coding agent</DialogTitle>
            <DialogDescription>
              Install the Autonoma MCP in your coding agent, then give it the pairing code below. It will configure and
              deploy your preview while you watch here.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-6">
            <PairingCode
              code={code}
              pending={createPairing.isPending}
              error={createPairing.isError}
              onRetry={() => createPairing.mutate({ applicationId })}
            />
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
                  {tab.location != null && <p className="text-2xs font-mono text-text-secondary">{tab.location}</p>}
                  <CopyableCode code={tab.snippet(MCP_URL)} />
                </TabsContent>
              ))}
            </Tabs>
            <p className="text-2xs text-text-secondary">
              Then tell your agent: <span className="font-mono text-text-primary">configure my preview</span>
              {code != null ? (
                <>
                  {" "}
                  with code <span className="font-mono text-primary">{code}</span>.
                </>
              ) : (
                "."
              )}
            </p>
            <a
              href={DOCS_URL}
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
    </>
  );
}

function PairingCode({
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

function CopyableCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  function copy() {
    void navigator.clipboard.writeText(code).then(() => setCopied(true));
  }

  return (
    <div className="relative">
      <pre className="overflow-x-auto border border-border-dim bg-surface-void p-3 font-mono text-2xs text-text-primary">
        {code}
      </pre>
      <Button variant="ghost" size="icon-xs" className="absolute right-2 top-2" onClick={copy} aria-label="Copy">
        {copied ? <CheckIcon className="text-status-success" /> : <CopyIcon />}
      </Button>
    </div>
  );
}
