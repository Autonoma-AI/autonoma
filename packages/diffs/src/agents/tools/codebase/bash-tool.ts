import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AgentTool } from "@autonoma/ai";
import { z } from "zod";
import type { CodebaseLoop } from "./codebase-loop";

const execFileAsync = promisify(execFile);

/**
 * Commands the bash tool will run. Adding to this list expands the agent's
 * available shell surface: keep it small and biased toward read-only inspection.
 */
const ALLOWED_COMMANDS = new Set(["git", "wc", "sort", "head", "tail", "cat", "ls", "find", "diff"]);

const CHAINING_OPERATORS = /;|&&|\|\||`|\$\(|>>|<<|&\s*$/;

const TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 1024 * 512;

const bashInputSchema = z.object({
    command: z.string().describe("The shell command to execute. Primarily intended for git operations."),
});

type BashInput = z.infer<typeof bashInputSchema>;

interface BashOutput {
    exitCode: number;
    stdout: string;
    stderr: string;
}

/**
 * Validate a shell command against the allowlist. Returns `undefined` when the
 * command is acceptable, or an explanatory error string otherwise.
 *
 * Exported so the unit tests can exercise the validator directly without
 * running the underlying shell.
 */
export function validateCommand(command: string): string | undefined {
    const trimmed = command.trim();
    if (trimmed.length === 0) return "Empty command is not allowed.";

    if (CHAINING_OPERATORS.test(trimmed)) {
        return "Command chaining (;, &&, ||), subshells ($(), ``), and redirects (>>, <<) are not allowed. Use pipes (|) to combine allowed commands.";
    }

    const segments = trimmed.split(/\s*\|\s*/);
    for (const segment of segments) {
        const binary = segment.trim().split(/\s+/)[0];
        if (binary == null || !ALLOWED_COMMANDS.has(binary)) {
            return `Command "${binary ?? ""}" is not allowed. Allowed commands: ${[...ALLOWED_COMMANDS].join(", ")}`;
        }
    }
    return undefined;
}

function blockResult(message: string): BashOutput {
    return { exitCode: 1, stdout: "", stderr: message };
}

/**
 * Run a single shell command in the codebase root. Disallowed commands and
 * non-zero exit codes are returned as success-shaped results (the tool ran,
 * the underlying command did not succeed) so the model can decide what to do.
 */
export class BashTool extends AgentTool<BashInput, BashOutput, CodebaseLoop> {
    constructor() {
        super({
            name: "bash",
            description:
                "Execute a shell command in the codebase root. " +
                "Primarily intended for git operations (git diff, git log, git status, git show, etc.) " +
                "and basic unix utilities (wc, sort, head, tail, ls, find, diff). " +
                "Commands can be piped together (e.g. git log | head -n 10) but chaining with ; && || is not allowed. " +
                "Do not use this for file reading (use read_files) or searching (use grep/glob).",
            inputSchema: bashInputSchema,
        });
    }

    protected async execute(input: BashInput, loop: CodebaseLoop): Promise<BashOutput> {
        const validationError = validateCommand(input.command);
        if (validationError != null) return blockResult(validationError);

        try {
            const { stdout, stderr } = await execFileAsync("sh", ["-c", input.command], {
                cwd: loop.codebase.root,
                maxBuffer: MAX_OUTPUT_BYTES,
                timeout: TIMEOUT_MS,
            });
            return {
                exitCode: 0,
                stdout: stdout.trimEnd(),
                stderr: stderr.trimEnd(),
            };
        } catch (error) {
            const execError = error as { code?: number; stdout?: string; stderr?: string; killed?: boolean };
            if (execError.killed === true) {
                return blockResult(`Command timed out after ${TIMEOUT_MS / 1000}s`);
            }
            return {
                exitCode: typeof execError.code === "number" ? execError.code : 1,
                stdout: execError.stdout?.trimEnd() ?? "",
                stderr: execError.stderr?.trimEnd() ?? "",
            };
        }
    }
}
