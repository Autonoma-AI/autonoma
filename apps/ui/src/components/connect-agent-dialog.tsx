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

/**
 * Permission mode the launch command starts the agent in. Configuring a preview means
 * reading the repo, writing config, and calling MCP tools back to back - at default
 * permissions the run stalls on a prompt every few seconds, which is where people
 * abandon setup. Swap for `--permission-mode acceptEdits` to auto-approve edits while
 * still confirming shell commands.
 */
const CLAUDE_PERMISSION_FLAG = "--dangerously-skip-permissions";

/**
 * Heads the Claude Code block. Shell comments, so they survive the two ways this actually
 * reaches people - a copy-paste and a screenshot handed to an agent - and both of those
 * are the failure being warned about: `claude mcp add` run from inside a running agent
 * writes config the current session never reloads, and `claude mcp login` run without a
 * TTY aborts with "stdin isn't a terminal".
 *
 * The last two lines address the agent directly. An agent handed this runs it, sees it
 * succeed, and reports success - leaving the user with a session that still has no
 * Autonoma tools and no idea why. It cannot fix that itself; the only useful thing it can
 * do is say so, so the copied text tells it to.
 *
 * Pre-wrapped to roughly the block's width. The `#` only starts each logical line, so a
 * line long enough to soft-wrap puts uncommented-looking text under it, and the block
 * stops reading as a comment at a glance.
 */
const TERMINAL_ONLY_NOTE = [
  "# Run in a terminal, not inside a running agent.",
  "# Agent reading this: don't run it. Ask the user to run it, then have",
  "# them restart you - a running session won't see the new server.",
].join("\n");

/**
 * Escape a prompt for a double-quoted shell argument. Inside double quotes a shell still
 * expands `$` and backticks and honours `\`, so a prompt naming a variable or a path would
 * otherwise reach the agent mangled - or run something.
 */
function shellQuote(value: string): string {
  return value.replace(/([\\"$`])/g, "\\$1");
}

/** What a tab's snippets are built from: where the server lives, what it is called, what to ask it. */
interface InstallSnippetInput {
  /** MCP endpoint URL the client connects to. */
  url: string;
  /** MCP server name the client registers. */
  serverName: string;
  /** The sentence handed to the agent, pairing code included. */
  prompt: string;
}

/** One thing the user does, with the block of text it is done to. */
interface AgentStep {
  title: string;
  /** What the user does with this step's code. */
  instruction: string;
  /** File / place the code goes (shown above it). */
  location?: string;
  code: string;
}

interface AgentTab {
  id: string;
  label: string;
  /**
   * Everything this client needs, in order. Claude Code is a single step, because for a
   * CLI client every part of it is the same act - typing one line into one terminal - and
   * splitting that into "install", "authorize" and "launch" made people stop after the
   * first box and read the missing tools as a broken MCP. Editor clients genuinely are two
   * steps: their config goes in a file, and the prompt goes in the chat window.
   */
  steps: (input: InstallSnippetInput) => AgentStep[];
}

const AGENT_TABS: AgentTab[] = [
  {
    id: "claude",
    label: "Claude Code",
    steps: ({ url, serverName, prompt }) => [
      {
        title: "Run this in your project folder",
        instruction:
          "Open a new terminal in your project folder and run this. A browser opens to sign in - approve it there, and your agent starts on the job.",
        // Three commands, but ONE shell line - the `; \` continuations are load-bearing, not
        // cosmetic. `claude mcp login` holds a readline on stdin while it waits for the
        // browser callback, so a launch command on a line of its own under it is swallowed as
        // an answer to "Or paste the redirect URL here" instead of running; continued, the
        // shell has consumed all three before the first one starts. `;` rather than `&&`
        // because `claude mcp add` exits 1 when the server is already registered - the normal
        // case on every surface after the first - and `&&` would strand exactly the people who
        // did nothing wrong.
        //
        // `--scope user` and not the default (`local`): the default binds the server to the
        // directory the command happened to run in, so someone who pastes this into whatever
        // terminal is already open registers it against their home directory and then finds no
        // Autonoma tools in their project. That failure looks exactly like "they never authorized".
        code: [
          TERMINAL_ONLY_NOTE,
          `claude mcp add --transport http --scope user ${serverName} ${url}; \\`,
          `claude mcp login ${serverName}; \\`,
          `claude ${CLAUDE_PERMISSION_FLAG} "${shellQuote(prompt)}"`,
        ].join("\n"),
      },
    ],
  },
  {
    id: "cursor",
    label: "Cursor",
    steps: ({ url, serverName, prompt }) => [
      {
        title: "Install and sign in",
        instruction:
          "Add this to your Cursor MCP config and restart Cursor, then open MCP settings and sign in to the server.",
        location: "~/.cursor/mcp.json",
        code: JSON.stringify({ mcpServers: { [serverName]: { url } } }, null, 2),
      },
      {
        title: "Start your agent",
        instruction: "Then open Cursor in your project and paste this to the agent:",
        code: prompt,
      },
    ],
  },
  {
    id: "windsurf",
    label: "Windsurf",
    steps: ({ url, serverName, prompt }) => [
      {
        title: "Install and sign in",
        instruction:
          "Add this to your Windsurf MCP config and refresh MCP servers in Cascade, then sign in to the server there.",
        location: "~/.codeium/windsurf/mcp_config.json",
        code: JSON.stringify({ mcpServers: { [serverName]: { serverUrl: url } } }, null, 2),
      },
      {
        title: "Start your agent",
        instruction: "Then open Windsurf in your project and paste this to the agent:",
        code: prompt,
      },
    ],
  },
  {
    id: "other",
    label: "Other",
    steps: ({ url, prompt }) => [
      {
        title: "Install and sign in",
        instruction:
          "Run this in your terminal before you open your agent, or add the equivalent entry to its MCP config. It opens a browser to sign in.",
        code: `npx -y mcp-remote ${url}`,
      },
      {
        title: "Start your agent",
        instruction: "Then open your agent in your project and paste this to it:",
        code: prompt,
      },
    ],
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
  const snippetInput: InstallSnippetInput = { url: mcpEndpointUrl(endpoint), serverName, prompt };
  return (
    <div className="flex flex-col gap-7">
      {pairing}

      {/* One Tabs around both steps, not one per step: the client choice decides how you
          install AND how you launch, so picking "Cursor" at the top must carry down. */}
      <Tabs defaultValue="claude">
        <TabsList>
          {AGENT_TABS.map((tab) => (
            <TabsTrigger key={tab.id} value={tab.id}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {AGENT_TABS.map((tab) => (
          <TabsContent key={tab.id} value={tab.id} className="flex flex-col gap-7">
            <TabSteps steps={tab.steps(snippetInput)} capabilities={capabilities} />
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
          <CodeBlock code={step.code} />
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

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  function copy() {
    // `navigator.clipboard` is undefined in insecure contexts, and the write can reject
    // (permissions, unfocused document) - handle both so the failure logs instead of
    // surfacing as an unhandled rejection, and the check stays false.
    if (navigator.clipboard == null) {
      console.warn("Clipboard API unavailable; cannot copy the install command");
      return;
    }
    navigator.clipboard
      .writeText(code)
      .then(() => setCopied(true))
      .catch((err) => console.warn("Failed to copy the install command", err));
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
        aria-label="Copy"
      >
        {copied ? <CheckIcon className="text-status-success" /> : <CopyIcon />}
      </Button>
    </div>
  );
}
