import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AgentTool } from "@autonoma/ai";
import { parse, type ParseEntry } from "shell-quote";
import { z } from "zod";
import type { CodebaseLoop } from "./codebase-loop";
import { CommandSandbox } from "./command-sandbox";

const execFileAsync = promisify(execFile);

/**
 * Read-only verbs the bash tool will run. Every entry is already present in the
 * worker image. Keep this small and biased toward read-only inspection - adding
 * a verb expands the agent's shell surface.
 *
 * NOTE: the allowlist + {@link validateCommand} are ergonomic guidance and a
 * first gate, **not** the security boundary. Several allowed verbs can still
 * write or execute within a single invocation (`find -exec`, `awk 'system()'`,
 * `sed -i`, `git` write subcommands). The durable boundary is process isolation.
 */
const ALLOWED_COMMANDS = new Set([
    "rg",
    "sed",
    "awk",
    "cat",
    "find",
    "ls",
    "head",
    "tail",
    "sort",
    "wc",
    "diff",
    "git",
    "echo",
]);

/** Sequencing/pipe operators the grammar permits between command segments. */
const ALLOWED_OPERATORS = new Set([";", "&&", "||", "|"]);

const TIMEOUT_MS = 30_000;

/**
 * Hard cap on bytes buffered from the child, protecting the host from a runaway
 * `cat`/`rg`. Set well above {@link MAX_STDOUT_CHARS} so the display truncation
 * (head+tail) is what the model normally sees; this only engages for pathological
 * output, and even then is handled gracefully rather than thrown.
 */
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/** Display budget for stdout. Output beyond this is truncated head+tail with a marker. */
const MAX_STDOUT_CHARS = 60_000;

/** Display budget for stderr. Smaller than stdout - stderr is rarely the payload. */
const MAX_STDERR_CHARS = 8_000;

const bashInputSchema = z.object({
    command: z
        .string()
        .describe("The shell command to run. See the tool description for the allowed verbs and grammar."),
});

type BashInput = z.infer<typeof bashInputSchema>;

interface BashOutput {
    exitCode: number;
    stdout: string;
    stderr: string;
}

/**
 * Validate a shell command against the allowlist and grammar. Returns `undefined`
 * when the command is acceptable, or an explanatory error string otherwise.
 *
 * Parsing is delegated to the `shell-quote` parser with a default-deny policy on
 * token type: only string tokens and the operators `; && || |` are allowed; glob
 * tokens are allowed as arguments but never as a command head; any other operator
 * or a comment token is rejected. The first token of each command segment must be
 * an allowlisted verb (this also rejects `VAR=val cmd` prefixes such as
 * `LD_PRELOAD=...`). No env map is passed to `parse()`, so `$VARS` are never
 * interpolated into the parsed tokens.
 *
 * Backticks are checked separately: `shell-quote` folds them into barewords rather
 * than emitting an operator, so a raw scan is the only way to block backtick
 * command substitution here.
 *
 * Exported so the unit tests can exercise the validator directly without running
 * the underlying shell.
 */
export function validateCommand(command: string): string | undefined {
    const trimmed = command.trim();
    if (trimmed.length === 0) return "Empty command is not allowed.";

    if (trimmed.includes("`")) {
        return "Backticks (command substitution) are not allowed.";
    }

    const tokens = parseTokens(trimmed);
    if (tokens == null) return "Command could not be parsed (unbalanced quotes?).";

    return validateTokens(tokens);
}

function parseTokens(command: string): ParseEntry[] | undefined {
    try {
        return parse(command);
    } catch {
        // `shell-quote` throws on a few malformed inputs (e.g. unbalanced quotes).
        // Treat that as a rejected command rather than a tool crash; the caller
        // turns the `undefined` into an explanatory message.
        return undefined;
    }
}

function validateTokens(tokens: ParseEntry[]): string | undefined {
    // Each command segment starts after a sequencing operator. `expectHead` is
    // true when the next string/glob token is the segment's command head.
    let expectHead = true;
    for (const token of tokens) {
        const error = validateToken(token, expectHead);
        if (error != null) return error;
        if (typeof token === "object" && "op" in token && ALLOWED_OPERATORS.has(token.op)) {
            expectHead = true;
            continue;
        }
        expectHead = false;
    }
    if (expectHead) return "Command segment is missing a command after a sequencing operator.";
    return undefined;
}

function validateToken(token: ParseEntry, expectHead: boolean): string | undefined {
    if (typeof token === "string") {
        if (!expectHead) return undefined;
        if (ALLOWED_COMMANDS.has(token)) return undefined;
        return `Command "${token}" is not allowed. Allowed commands: ${[...ALLOWED_COMMANDS].join(", ")}.`;
    }
    if ("comment" in token) return "Comments (#) are not allowed.";
    if (token.op === "glob") {
        if (expectHead) return "A glob pattern cannot be used as a command name.";
        return undefined;
    }
    if (ALLOWED_OPERATORS.has(token.op)) {
        if (expectHead) return `Operator "${token.op}" is not allowed at the start of a command segment.`;
        return undefined;
    }
    return `Operator "${token.op}" is not allowed. Only pipes (|) and sequencing (; && ||) are permitted; subshells, redirects, and background (&) are blocked.`;
}

function blockResult(message: string): BashOutput {
    return { exitCode: 1, stdout: "", stderr: message };
}

/**
 * Build the minimal environment the child process runs with, forwarding only the
 * OS passthrough vars binaries need (`PATH` to resolve `git`/`rg`/..., plus
 * `HOME`/`LANG` for locale and git config lookups). Everything else - including
 * any worker secrets - is dropped, so `echo $TOKEN` yields empty.
 *
 * Pure over `source`; the caller reads `process.env` at the boundary. This is
 * OS-level passthrough for a sandboxed subprocess, not application configuration,
 * so it intentionally does not go through `createEnv`.
 *
 * Exported so the unit tests can verify the scrub directly.
 */
export function buildSafeEnv(source: NodeJS.ProcessEnv): Record<string, string> {
    const allowedKeys = ["PATH", "HOME", "LANG"];
    const env: Record<string, string> = {};
    for (const key of allowedKeys) {
        const value = source[key];
        if (value != null) env[key] = value;
    }
    return env;
}

/**
 * Cap `text` to `budget` characters, keeping the head and tail and replacing the
 * elided middle with an explanatory marker. Returns the input unchanged when it
 * already fits. Exported so the unit tests can exercise it directly.
 */
export function truncateOutput(text: string, budget: number, label: string): string {
    if (text.length <= budget) return text;
    const headChars = Math.floor(budget * 0.7);
    const tailChars = budget - headChars;
    const head = text.slice(0, headChars);
    const tail = text.slice(text.length - tailChars);
    const elided = text.length - headChars - tailChars;
    const marker = `\n\n[...${label} truncated: ${elided} chars elided of ${text.length} total. Showing the first ${headChars} and last ${tailChars} characters. Narrow the command (rg with a pattern, sed -n '<start>,<end>p' for slices, or head/tail) to see less.]\n\n`;
    return `${head}${marker}${tail}`;
}

interface ExecFailure {
    code?: number | string;
    signal?: string;
    killed?: boolean;
    stdout?: string;
    stderr?: string;
}

/** Read the loosely-typed fields off a thrown `execFile` error without casting. */
function readExecFailure(error: unknown): ExecFailure {
    if (typeof error !== "object" || error === null) return {};
    const failure: ExecFailure = {};
    if ("code" in error && (typeof error.code === "number" || typeof error.code === "string")) {
        failure.code = error.code;
    }
    if ("signal" in error && typeof error.signal === "string") failure.signal = error.signal;
    if ("killed" in error && typeof error.killed === "boolean") failure.killed = error.killed;
    if ("stdout" in error && typeof error.stdout === "string") failure.stdout = error.stdout;
    if ("stderr" in error && typeof error.stderr === "string") failure.stderr = error.stderr;
    return failure;
}

/**
 * General-purpose read-only shell tool for the codebase research agents.
 *
 * Disallowed commands and non-zero exit codes are returned as success-shaped
 * results (the tool ran; the underlying command did not succeed) so the model can
 * decide what to do. Oversized output is truncated gracefully rather than thrown,
 * and the child runs with a scrubbed environment so worker secrets are never
 * visible to it.
 *
 * The durable security boundary is the {@link CommandSandbox}, which isolates the
 * child process (no writes, no network, no host reads outside the clone). The
 * allowlist validator is a first gate and ergonomic guidance, not the boundary.
 */
export class BashTool extends AgentTool<BashInput, BashOutput, CodebaseLoop> {
    private readonly sandbox = new CommandSandbox();

    constructor() {
        super({
            name: "bash",
            description:
                "Run a read-only shell command in the codebase root to read and search the source tree.\n\n" +
                "Allowed verbs: rg, sed, awk, cat, find, ls, head, tail, sort, wc, diff, git, echo. " +
                "Grammar: pipes (|) and sequencing (; && ||) between allowed verbs are permitted; " +
                "subshells / command substitution ($(...), backticks), all redirects (>, >>, <, <<, here-docs), and background (&) are rejected.\n\n" +
                "Guidance:\n" +
                "- Prefer `rg` for searching - it inherits .gitignore and skips hidden files automatically.\n" +
                "- Use `sed -n '<start>,<end>p' <file>` to read a slice of a file instead of catting the whole thing.\n" +
                "- Pass multiple paths to a single `cat` rather than calling the tool repeatedly.\n" +
                "- For non-`rg` verbs (find, ls, wc, ...), exclude node_modules, dist, and .git yourself.\n\n" +
                `Output is capped at ${MAX_STDOUT_CHARS} characters (stderr at ${MAX_STDERR_CHARS}); beyond that the head and tail are kept and the middle is replaced with a truncation marker, so narrow the command if you see one.`,
            inputSchema: bashInputSchema,
        });
    }

    protected async execute(input: BashInput, loop: CodebaseLoop): Promise<BashOutput> {
        const validationError = validateCommand(input.command);
        if (validationError != null) return blockResult(validationError);

        const env = buildSafeEnv(process.env);
        const spec = this.sandbox.wrap(input.command, loop.codebase.root, env);

        try {
            const { stdout, stderr } = await execFileAsync(spec.file, spec.args, {
                cwd: loop.codebase.root,
                env: spec.env,
                maxBuffer: MAX_BUFFER_BYTES,
                timeout: TIMEOUT_MS,
            });
            return {
                exitCode: 0,
                stdout: truncateOutput(stdout.trimEnd(), MAX_STDOUT_CHARS, "stdout"),
                stderr: truncateOutput(stderr.trimEnd(), MAX_STDERR_CHARS, "stderr"),
            };
        } catch (error) {
            return this.handleExecError(error);
        }
    }

    private handleExecError(error: unknown): BashOutput {
        const failure = readExecFailure(error);

        if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
            this.logger.warn("Command output exceeded the capture buffer; returning truncated output", {
                extra: { maxBufferBytes: MAX_BUFFER_BYTES },
            });
            const head = truncateOutput(failure.stdout?.trimEnd() ?? "", MAX_STDOUT_CHARS, "stdout");
            const note = `\n\n[...output exceeded the ${MAX_BUFFER_BYTES}-byte capture buffer and was cut off. Narrow the command to see the rest.]`;
            return {
                exitCode: 0,
                stdout: `${head}${note}`,
                stderr: truncateOutput(failure.stderr?.trimEnd() ?? "", MAX_STDERR_CHARS, "stderr"),
            };
        }

        if (failure.killed === true) {
            this.logger.warn("Command timed out", { extra: { timeoutMs: TIMEOUT_MS } });
            return blockResult(`Command timed out after ${TIMEOUT_MS / 1000}s.`);
        }

        return {
            exitCode: typeof failure.code === "number" ? failure.code : 1,
            stdout: truncateOutput(failure.stdout?.trimEnd() ?? "", MAX_STDOUT_CHARS, "stdout"),
            stderr: truncateOutput(failure.stderr?.trimEnd() ?? "", MAX_STDERR_CHARS, "stderr"),
        };
    }
}
