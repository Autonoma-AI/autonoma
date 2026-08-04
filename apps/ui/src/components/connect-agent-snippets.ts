/**
 * How each client is installed, launched, and - for the one that cannot sign in through a
 * browser - authenticated. Kept apart from the dialog that renders it so the text an agent
 * actually receives can be read, and tested, without a React tree or a tRPC client.
 */

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
export interface InstallSnippetInput {
    /** MCP endpoint URL the client connects to. */
    url: string;
    /** MCP server name the client registers. */
    serverName: string;
    /** The sentence handed to the agent, pairing code included. */
    prompt: string;
    /**
     * Creates an API key and returns it, for the one tab that ships a credential. Called when
     * the block is copied rather than when it is rendered, so nobody who merely looks at the
     * tab ends up with a live secret in their organization.
     */
    mintKey: () => Promise<string>;
}

/** One thing the user does, with the block of text it is done to. */
export interface AgentStep {
    title: string;
    /** What the user does with this step's code. */
    instruction: string;
    /** File / place the code goes (shown above it). */
    location?: string;
    code: string;
    /**
     * Produces what actually reaches the clipboard, when that differs from what is displayed.
     * Absent for every ordinary step, where the two are the same text.
     */
    resolveCopyText?: () => Promise<string>;
}

/**
 * Appended to every browser-client block, in the clipboard only.
 *
 * The tab a user picks says which client they run, not which machine it runs on - Codex over
 * SSH, Claude Code on a dev box, an agent in a container all reach the browser step and stop,
 * with no way forward except asking the user to start again on the other tab. The fallback
 * rides along invisibly instead: an agent that cannot open a browser finds a credential
 * already in its hands and keeps going.
 *
 * Never rendered. It carries a live key, so putting it on screen would leak it to every
 * screenshot and screen share of a screen most people have no reason to treat as sensitive.
 */
export function withRemoteFallback(code: string, url: string, apiKey: string): string {
    return [
        code,
        "",
        "# If you cannot complete the browser sign-in - no browser, a remote machine, SSH, CI -",
        "# skip the sign-in step and authenticate with this header instead. It is already valid.",
        `#   URL             ${url}`,
        "#   Transport       Streamable HTTP",
        `#   Authorization   Bearer ${apiKey}`,
    ].join("\n");
}

/**
 * What the remote-agent block shows where the key goes. The real key never reaches the
 * screen: it is minted when the block is copied and exists only in the clipboard, so a
 * screenshot, a screen share, or someone reading over a shoulder cannot leak it.
 */
export const MASKED_KEY = "ask_" + "•".repeat(24);

/** Length of the `YYYY-MM-DD` prefix of an ISO timestamp, used to date the minted key. */
const ISO_DATE_LENGTH = 10;

/**
 * Name the minted key carries in the org's key list, so it can be recognised and revoked
 * months later. Named after the MCP server rather than an application: an API key
 * authenticates an organization, and an app name would promise a scope it does not have.
 */
export function remoteAgentKeyName(serverName: string): string {
    return `Remote agent - ${serverName} - ${new Date().toISOString().slice(0, ISO_DATE_LENGTH)}`;
}

/** Hover copy on the remote-agent tab, naming the agents that cannot complete OAuth. */
export const REMOTE_AGENT_HINT =
    "OpenClaw, Hermes, Devin, a CI job - anywhere OAuth is impossible because there is no browser to sign in with.";

/**
 * The remote-agent handoff: one message carrying the connection, the credential and the
 * first instruction, because the agent receiving it has no config screen of its own and no
 * second chance to be told anything.
 *
 * `apiKey` is absent on screen and present in the clipboard - see {@link MASKED_KEY}.
 */
function remoteAgentBlock({ url, serverName, prompt }: InstallSnippetInput, apiKey: string): string {
    return [
        `# Autonoma ${serverName} MCP. No sign-in needed - this key authenticates you.`,
        `# URL             ${url}`,
        "# Transport       Streamable HTTP",
        `# Authorization   Bearer ${apiKey}`,
        "",
        prompt,
    ].join("\n");
}

export interface AgentTab {
    id: string;
    label: string;
    /** Shown on hover, for a tab whose label cannot say everything it needs to. */
    hint?: string;
    /**
     * Whether this client's install step should carry {@link withRemoteFallback} in the
     * clipboard. True for every client that signs in through a browser; the remote-agent tab
     * already IS the fallback.
     */
    fallbackOnFirstStep?: boolean;
    /**
     * Everything this client needs, in order. Claude Code is a single step, because for a
     * CLI client every part of it is the same act - typing one line into one terminal - and
     * splitting that into "install", "authorize" and "launch" made people stop after the
     * first box and read the missing tools as a broken MCP. Editor clients genuinely are two
     * steps: their config goes in a file, and the prompt goes in the chat window.
     */
    steps: (input: InstallSnippetInput) => AgentStep[];
}

export const AGENT_TABS: AgentTab[] = [
    {
        id: "claude",
        fallbackOnFirstStep: true,
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
        id: "codex",
        fallbackOnFirstStep: true,
        label: "Codex",
        steps: ({ url, serverName, prompt }) => [
            {
                title: "Install and sign in",
                instruction:
                    "Add this to your Codex config. Codex reaches remote servers through the mcp-remote bridge, which opens a browser to sign in the first time.",
                location: "~/.codex/config.toml",
                code: [
                    `[mcp_servers.${serverName}]`,
                    'command = "npx"',
                    `args = ["-y", "mcp-remote", ${JSON.stringify(url)}]`,
                ].join("\n"),
            },
            {
                title: "Start your agent",
                instruction: "Then run Codex in your project and paste this to it:",
                code: prompt,
            },
        ],
    },
    {
        id: "other",
        fallbackOnFirstStep: true,
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
    {
        id: "remote",
        label: "Remote agent",
        hint: REMOTE_AGENT_HINT,
        // The only tab that does not sign in through a browser, and the only one whose block
        // carries a credential. Every other client here runs on the user's own machine, where
        // OAuth works and is the better answer - offering a key there would trade a scoped,
        // revocable-by-signing-out session for a long-lived org-wide secret for no reason.
        steps: (input) => [
            {
                title: "Send this to your agent",
                instruction:
                    "One message with everything it needs. Copying it creates an API key and includes it here - the key is never shown on screen, and you can revoke it any time under Settings, API keys.",
                code: remoteAgentBlock(input, MASKED_KEY),
                resolveCopyText: async () => remoteAgentBlock(input, await input.mintKey()),
            },
        ],
    },
];

/**
 * A tab's steps, with the invisible remote fallback attached to the install step of every
 * client that signs in through a browser.
 */
export function stepsWithFallback(tab: AgentTab, input: InstallSnippetInput): AgentStep[] {
    const steps = tab.steps(input);
    const [install, ...rest] = steps;
    if (tab.fallbackOnFirstStep !== true || install == null) return steps;
    return [
        {
            ...install,
            resolveCopyText: async () => withRemoteFallback(install.code, input.url, await input.mintKey()),
        },
        ...rest,
    ];
}
