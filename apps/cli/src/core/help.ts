import { BOLD, DIM, RESET } from "./colors";
import { selfInvocation } from "./self-invocation";

/** Where the prose lives, and where an agent should read it from instead. */
const DOCS_URL = "https://docs.autonoma.app/test-planner/";
const LLMS_URL = "https://docs.autonoma.app/llms.txt";
const LLMS_FULL_URL = "https://docs.autonoma.app/llms-full.txt";

/** One flag, in every spelling that reaches it. */
interface FlagSpec {
    /** Accepted spellings. The first is the one the help text shows. */
    names: string[];
    /** What it takes. Absent for a flag that is only ever present or absent. */
    argument?: string;
    summary: string;
}

/**
 * Every flag the run accepts.
 *
 * This is the list, not a description of it: the help text below and the set of
 * spellings the parser recognizes are both derived from here, so a flag cannot be
 * added to one and forgotten in the other - or documented and then not accepted,
 * which is the failure a caller reading `--help` would hit first.
 */
const FLAGS: readonly FlagSpec[] = [
    {
        names: ["project"],
        argument: "<path>",
        summary: "The repository to plan tests for. Defaults to the current directory.",
    },
    {
        names: ["non-interactive"],
        summary:
            "Never ask a question. Every input has to be a flag, the coding agent runs headless " +
            "and autonomous, and the run authorizes with an API key instead of a browser.",
    },
    {
        names: ["frontend"],
        argument: "<path>",
        summary:
            "The one frontend directory to plan tests for. Only needed in a repository with more " +
            "than one - a single-app repository resolves itself.",
    },
    {
        names: ["backend", "backends"],
        argument: "<path>",
        summary:
            "A backend or data layer that frontend talks to. Repeatable, and also accepts a " +
            "comma-separated list. Omit to use the dependencies the run infers.",
    },
    {
        names: ["agent", "coding-agent"],
        argument: "<claude|codex>",
        summary:
            "Which coding agent to hand the preview environment and the SDK integration to. " +
            "Omit to use whichever is installed; required when both are and nobody can be asked.",
    },
    {
        names: ["permission-mode"],
        argument: "<default|acceptEdits|bypassPermissions>",
        summary:
            "How much autonomy that agent runs with. Defaults to bypassPermissions, which is the " +
            "only one that means anything without a human at the keyboard.",
    },
    {
        names: ["resume"],
        summary: "Continue a previous run from where it stopped instead of starting over.",
    },
    {
        names: ["fresh"],
        summary: "Discard a previous run's output and start over. The opposite of --resume.",
    },
    {
        names: ["step"],
        argument: "<name>",
        summary:
            "Run a single step and stop. For debugging one step in isolation - it is not how a " +
            "caller sequences a run, which happens in one invocation.",
    },
    {
        names: ["model"],
        argument: "<id>",
        summary: "Override the model the analysis runs on.",
    },
    {
        names: ["slug"],
        argument: "<name>",
        summary: "Override the output folder name under ~/.autonoma/.",
    },
    {
        names: ["help"],
        summary: "Print this.",
    },
];

/** Every spelling the parser should accept, derived from the documented flags. */
export const KNOWN_FLAGS: ReadonlySet<string> = new Set(FLAGS.flatMap((flag) => flag.names));

/** Left column width for the flag list, so the summaries line up. */
const FLAG_COLUMN = 34;

const WHAT_IT_DOES = [
    "Autonoma's planner reads a codebase and produces the end-to-end test suite for it - the pages,",
    "the data models, the flows a user actually takes - and hands the parts that need judgement to a",
    "coding agent you already have installed. One invocation does the whole thing:",
    "",
    "  1. Preview environment   Your coding agent sets up a real deployment of your app, built per",
    "                           pull request, that Autonoma tests against. Skipped when you already",
    "                           have one.",
    "  2. Project map           Which directories are frontends, which are backends, which to ignore.",
    "  3. Pages and flows       What your app can do, read from its source rather than guessed.",
    "  4. Knowledge base        A written account of the app the later steps plan against.",
    "  5. Data models           An audit of the entities your test data has to create.",
    "  6. Test scenarios        The named app states your tests depend on.",
    "  7. Test data             Your coding agent wires the Autonoma SDK into your repo and writes a",
    "                           factory per entity, validating each against your running app.",
    "  8. Test suite            The test cases themselves, then uploaded to Autonoma.",
    "",
    "Nothing here is a step list to run one at a time. There is one command, it runs to the end, and",
    "it resumes from where it stopped if it is interrupted.",
];

const HEADLESS = [
    "With --non-interactive there is nobody to answer a question, so anything that would have been",
    "asked has to arrive as a flag. What the run does about that:",
    "",
    "  - It never opens a browser. The coding agent's Autonoma connection is authorized with the",
    "    AUTONOMA_API_TOKEN this run already holds.",
    "  - It never blocks on a question. Where it has to assume an answer it says so on stdout,",
    "    naming what was asked and what it took.",
    "  - It reports each step as it starts and finishes, with how long it took, so the process that",
    "    launched it can follow along.",
    "  - It refuses rather than guesses when a choice would be arbitrary - two coding agents",
    "    installed and no --agent, several frontends and no --frontend.",
];

const ENVIRONMENT = [
    "  AUTONOMA_API_TOKEN        Required. The run's credential. Create one in Settings -> API keys.",
    "  AUTONOMA_APPLICATION_ID   The Autonoma app this run belongs to. Set it and the run also sets",
    "                            up the preview environment and validates the result; leave it unset",
    "                            and the planner runs standalone against any repository.",
    "  AUTONOMA_API_URL          Point at a non-production Autonoma. Defaults to production.",
    // Both are read as `1`/`true` exactly (core/posthog.ts, core/debug-sink.ts), so
    // "set to anything" invites DONT_TRACK=0 - which reads as opted IN.
    "  AUTONOMA_DEBUG            Set to 1 or true for diagnostics on stderr, plus a full JSONL",
    "                            transcript at ~/.autonoma/debug/<run-id>.jsonl.",
    "  AUTONOMA_DEBUG_FILE       Write that transcript to this path instead, without the stderr",
    "                            noise. Independent of DONT_TRACK - it never leaves your machine.",
    "  DONT_TRACK                Set to 1 or true to turn off analytics, logs and session replay.",
];

/**
 * The full `--help`, written for whoever is reading it - which is as often an agent
 * that was handed a command as a person who typed one. That is why it explains what
 * the run DOES before it lists flags, says plainly that there is no step sequence to
 * drive, and ends by naming where the machine-readable documentation is.
 */
export function renderHelp(): string {
    const self = selfInvocation();
    return [
        `${BOLD}@autonoma-ai/planner${RESET} - generate an end-to-end test suite from your codebase`,
        "",
        // Spelled the way this run was actually reached. Almost everyone arrives via
        // npx, which installs nothing on PATH, so a synopsis written as a bare
        // `autonoma-planner` teaches a command the reader does not have.
        `${BOLD}USAGE${RESET}`,
        `  ${self} [run] [flags]   Plan and generate the suite. \`run\` may be omitted.`,
        `  ${self} status          Show what a previous run completed.`,
        `  ${self} upload          Re-upload an already-generated suite.`,
        `  ${self} help            Print this.`,
        "",
        `${BOLD}WHAT IT DOES${RESET}`,
        ...WHAT_IT_DOES.map(indent),
        "",
        `${BOLD}FLAGS${RESET}`,
        ...FLAGS.map(renderFlag),
        "",
        `${BOLD}RUNNING WITHOUT A HUMAN${RESET}`,
        ...HEADLESS.map(indent),
        "",
        `${BOLD}ENVIRONMENT${RESET}`,
        ...ENVIRONMENT,
        "",
        `${BOLD}DOCUMENTATION${RESET}`,
        `  ${DOCS_URL}`,
        `  ${DIM}${LLMS_URL} - every page, as a list, for an agent to read${RESET}`,
        `  ${DIM}${LLMS_FULL_URL} - all of it in one file${RESET}`,
        "",
    ].join("\n");
}

function indent(line: string): string {
    return line.length > 0 ? `  ${line}` : line;
}

/**
 * One flag as `  --name <arg>   summary`, wrapped under a hanging indent. A spelling
 * too long for the column takes the whole line and drops its summary underneath,
 * rather than shunting one line of prose out of alignment with the rest.
 */
function renderFlag(flag: FlagSpec): string {
    const spellings = flag.names.map((name) => `--${name}`).join(", ");
    const left = `  ${spellings}${flag.argument != null ? ` ${flag.argument}` : ""}`;
    const indented = wrap(flag.summary, 92 - FLAG_COLUMN).map((line) => `${" ".repeat(FLAG_COLUMN)}${line}`);

    if (left.length >= FLAG_COLUMN) return [left, ...indented].join("\n");

    const [first, ...rest] = indented;
    return [`${left}${(first ?? "").slice(left.length)}`, ...rest].join("\n");
}

/** Greedy word wrap. The help text is the one place the CLI lays out its own prose. */
function wrap(text: string, width: number): string[] {
    const lines: string[] = [];
    let current = "";

    for (const word of text.split(" ")) {
        if (current.length === 0) {
            current = word;
            continue;
        }
        if (current.length + 1 + word.length > width) {
            lines.push(current);
            current = word;
            continue;
        }
        current = `${current} ${word}`;
    }
    if (current.length > 0) lines.push(current);

    return lines;
}
