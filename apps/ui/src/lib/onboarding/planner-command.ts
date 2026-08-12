/**
 * The one command Autonoma hands people to run.
 *
 * It appears on two screens - the connect screen, where it is the whole of setup,
 * and Finish setup, where it uploads test artifacts - and they must never drift:
 * people paste it verbatim, and a variable missing from one of them is a run that
 * silently does less than the other.
 */

/** Where an agent reading the copied text is pointed for everything this can do. */
export const PLANNER_DOCS_URL = "https://docs.autonoma.app/test-planner/";

/** Stand-in shown on screen wherever a real credential would otherwise be rendered. */
const MASKED_VALUE = "•".repeat(24);

/** What the command actually runs, whichever shell it is written for. */
const PLANNER_PACKAGE = "@autonoma-ai/planner@latest";

/**
 * The shells this command has to survive being pasted into, in the order the selector
 * offers them.
 *
 * They are not stylistic variants of each other. The POSIX `NAME=value cmd` prefix
 * form has no equivalent in either Windows shell, so a command copied for the wrong
 * one does not misbehave subtly - PowerShell reads the first `NAME=value` as the name
 * of a program and stops on `CommandNotFoundException` before anything runs, which
 * reads to the user as a broken product rather than a wrong shell.
 *
 * This list is the source of the `CommandShell` union rather than a rendering of it,
 * so a shell added here has no dialect until one is written for it and does not
 * compile until it is.
 */
export const COMMAND_SHELLS = [
    { id: "posix", label: "macOS / Linux" },
    { id: "powershell", label: "Windows (PowerShell)" },
    { id: "cmd", label: "Windows (cmd)" },
] as const;

export type CommandShell = (typeof COMMAND_SHELLS)[number]["id"];

/** What a shell is called on screen. */
export function commandShellLabel(shell: CommandShell): string {
    return COMMAND_SHELLS.find((option) => option.id === shell)?.label ?? shell;
}

/** One `NAME=value` the run needs, before any shell has decided how to write it. */
interface CommandVariable {
    name: string;
    value: string;
}

/** Everything that differs between the shells, so nothing else has to branch. */
interface ShellDialect {
    /** Runs ahead of everything else, when the shell needs setting up to accept a paste. */
    preamble?: string;
    /** Turns one line of prose into something this shell ignores. */
    comment: (line: string) => string;
    /** The variables and the invocation, as the shell wants them. */
    render: (variables: CommandVariable[], subcommand?: string) => string;
}

const DIALECTS: Record<CommandShell, ShellDialect> = {
    posix: {
        // zsh does not treat `#` as a comment interactively unless
        // `interactive_comments` is set, and it is OFF by default - the shells where
        // pasting this works have it turned on by a dotfile. Without it, an apostrophe
        // in the prose below opens a quote that swallows the command and the
        // credentials after it, and the user is left at a `quote>` prompt with nothing
        // run. Setting it first costs one line and makes the paste behave the same
        // everywhere; in bash, which comments interactively anyway, the line fails
        // silently and changes nothing.
        preamble: "setopt interactive_comments 2>/dev/null || true",
        comment: (line) => (line === "" ? "#" : `# ${line}`),
        // Prefix assignments scope the credentials to this one command, so a live
        // token is not left set in the shell after the run.
        render: (variables, subcommand) =>
            [...variables.map(({ name, value }) => `${name}=${value}`), `npx ${PLANNER_PACKAGE}`, subcommand]
                .filter((part): part is string => part != null)
                .join(" "),
    },
    powershell: {
        comment: (line) => (line === "" ? "#" : `# ${line}`),
        // Unlike the POSIX prefix form these persist for the rest of the session, so a
        // second run in the same window needs no re-paste - and closing it is what
        // clears the token.
        //
        // The package name is quoted because PowerShell gives a leading `@` its own
        // meaning in argument position; quoting settles it as a plain string.
        render: (variables, subcommand) =>
            [
                ...variables.map(({ name, value }) => `$env:${name}="${value}"`),
                `npx "${PLANNER_PACKAGE}"${subcommand != null ? ` ${subcommand}` : ""}`,
            ].join("\n"),
    },
    cmd: {
        comment: (line) => (line === "" ? "REM" : `REM ${line}`),
        // `set "NAME=value"` rather than `set NAME=value`: the quoted form is what
        // keeps a trailing space (easy to paste in, invisible on screen) out of the
        // value, and cmd strips the quotes itself.
        render: (variables, subcommand) =>
            [
                ...variables.map(({ name, value }) => `set "${name}=${value}"`),
                `npx ${PLANNER_PACKAGE}${subcommand != null ? ` ${subcommand}` : ""}`,
            ].join("\n"),
    },
};

/**
 * Which shell to write the command for before the user says otherwise.
 *
 * Only Windows makes the guess matter, and there PowerShell beats cmd: it is the
 * default terminal on Windows 11 and what "Open in Terminal" gives you. Someone
 * running Git Bash or WSL picks macOS / Linux from the selector, which costs them one
 * click - far less than the failed paste costs everyone we guess wrong about.
 */
export function defaultShellForUserAgent(userAgent: string): CommandShell {
    return /windows/i.test(userAgent) ? "powershell" : "posix";
}

/**
 * Heads the copied text, and is deliberately NOT rendered on screen.
 *
 * It exists for readers the screen never reaches, and there are two of them, wanting
 * opposite things:
 *
 * A LOCAL agent, because the user pasted this into a session they already had open.
 * It must NOT run this itself. The command takes the terminal over and starts a
 * coding agent of its own, so running it from inside one nests two agents fighting
 * over the same screen. It should hand the command back to the person, who has a
 * terminal.
 *
 * A HOSTED agent, which has no person to hand anything to and no terminal to sign in
 * from. It must run this itself, with `--non-interactive`, which is the only path it
 * has.
 *
 * The instruction names products on both sides rather than only describing the
 * situation. A model recognises "you are Claude Code" faster and more reliably than
 * it reasons about whether a human is sitting beside it, and getting that wrong is
 * what decides between two agents deadlocked on one terminal and a run that never
 * starts. The principle follows the names, for anything the list does not cover.
 *
 * Losing these lines to brevity loses both audiences at once.
 */
function copyHeader(shell: CommandShell): string {
    const dialect = DIALECTS[shell];
    const prose = [
        "Autonoma sets up your preview environment and generates your test suite.",
        "Run this in a terminal, from your project folder.",
        "",
        "Agent reading this - which are you?",
        "",
        "A coding agent running beside a human (Claude Code, Codex, Cursor): do NOT run",
        "this yourself. Give it to them to run in their own terminal. It takes the",
        "terminal over and starts a coding agent of its own, so running it from inside",
        "one leaves two agents fighting over the same screen.",
        "",
        "A hosted agent with no human beside you (OpenClaw, Hermes, Devin, a CI job):",
        "run it yourself and add --non-interactive. There is nobody to hand it to and",
        "no terminal to sign in from, so that flag is your path.",
        "",
        "  --help              every action this can take",
        `  docs                ${PLANNER_DOCS_URL}`,
    ];

    return [dialect.preamble, ...prose.map(dialect.comment)].filter((line): line is string => line != null).join("\n");
}

/** Everything the planner needs to attach a run to an Autonoma application. */
export interface PlannerCommandEnv {
    /**
     * Which Autonoma to talk to.
     *
     * Emitted always, from the same `VITE_API_URL` every other call in this app is
     * built from, rather than left to the CLI's own default. The command is copied
     * off whichever Autonoma the user is looking at, and its app id only exists
     * there - so a command copied from beta that silently addressed production
     * would fail on an application production has never heard of.
     */
    apiUrl: string;
    /** Authenticates the run; also what it uploads with. */
    apiToken: string;
    /** The setup its uploads belong to. */
    generationId: string;
    /** The application itself - what onboarding calls are keyed by. */
    applicationId: string;
    /** Signs SDK/webhook requests. Absent until the app has one. */
    sharedSecret?: string;
    /** PostHog identity, so CLI events join the signup funnel. */
    distinctId?: string;
}

export interface PlannerCommandOptions {
    /** Replace credential VALUES with dots, for the on-screen copy. */
    masked?: boolean;
    /** Which shell to write it for. */
    shell?: CommandShell;
    /** Appended to the planner invocation itself, e.g. `upload`. */
    subcommand?: string;
}

/**
 * Build the command.
 *
 * `masked` replaces credential VALUES with dots for the on-screen copy. The real
 * command goes only to the clipboard, so a screenshot, a screen share, or someone
 * reading over a shoulder cannot leak a live token from a screen nobody thinks of as
 * sensitive.
 */
export function buildPlannerCommand(env: PlannerCommandEnv, options: PlannerCommandOptions = {}): string {
    const { masked = false, shell = "posix", subcommand } = options;
    const secret = (value: string): string => (masked ? MASKED_VALUE : value);
    const variables: CommandVariable[] = [
        { name: "AUTONOMA_API_URL", value: env.apiUrl },
        env.sharedSecret != null ? { name: "AUTONOMA_SHARED_SECRET", value: secret(env.sharedSecret) } : undefined,
        env.distinctId != null ? { name: "AUTONOMA_DISTINCT_ID", value: env.distinctId } : undefined,
        { name: "AUTONOMA_API_TOKEN", value: secret(env.apiToken) },
        { name: "AUTONOMA_GENERATION_ID", value: env.generationId },
        // Identifies the app itself, not this setup's uploads: it is what lets the CLI
        // read onboarding status, skip phases already done, and mint pairing codes for
        // the coding agents it hands off to.
        { name: "AUTONOMA_APPLICATION_ID", value: env.applicationId },
    ].filter((variable): variable is CommandVariable => variable != null);

    return DIALECTS[shell].render(variables, subcommand);
}

/** The command as it reaches the clipboard: the guidance header, then the real thing. */
export function buildPlannerCommandForCopy(env: PlannerCommandEnv, shell: CommandShell = "posix"): string {
    return `${copyHeader(shell)}\n${buildPlannerCommand(env, { shell })}`;
}
