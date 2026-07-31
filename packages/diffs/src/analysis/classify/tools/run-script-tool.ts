import { AgentTool, FixableToolError } from "@autonoma/ai";
import { causeMessage } from "@autonoma/errors";
import { z } from "zod";
import { truncateOutput } from "../../../agents/tools/truncate-output";
import type { PreviewAccess } from "../types";

const MAX_CHARS = 24_000;

const runScriptInputSchema = z.object({
    script: z.string().describe("ESM Node script body. Print findings with console.log. Top-level await is allowed."),
    packages: z
        .array(z.string())
        .optional()
        .describe("npm packages to install first, e.g. ['pg'] or ['firebase-admin']"),
});

type RunScriptInput = z.infer<typeof runScriptInputSchema>;

class ScriptHarnessError extends FixableToolError {
    constructor(cause: unknown) {
        super(`Could not run the script against the preview backend: ${causeMessage(cause)}`);
    }

    override suggestFix(): string {
        return "Fix the script if the error is in your code (a bad import, a wrong connection var - check get_preview_env for the names available). If the harness itself is unreachable, stop querying and say plainly that the backend mechanism is UNCONFIRMED: prefer environment_failure / scenario_issue over a client_bug you could not prove.";
    }
}

/**
 * The run-script harness: confirm whether the data the test needs actually exists in the live backend.
 *
 * Overflow is truncated head+tail and NEVER narrowed with a re-call hint: a script can carry a
 * non-idempotent operation (a scenario `up`, say), so the model must not be nudged into re-running one.
 */
export class RunScriptTool extends AgentTool<RunScriptInput, string> {
    constructor(private readonly preview: PreviewAccess) {
        super({
            name: "run_script",
            description:
                "Write and run a throwaway Node.js (ESM) script against the LIVE preview backend, with the preview app's STORED secrets injected. Use it to CONFIRM whether the data the test needs actually exists - install the client's DB/backend SDK ('pg', 'firebase-admin', ...) and query for the specific record. Read-only: query and print with console.log, never mutate. A hit is strong evidence; a MISS is only evidence once you have checked the environment caveat printed above the output, which names any var whose value here differs from the one the preview pod ran with (those point at a different backend, so 'not found' would prove nothing). " +
                `Output is capped at ${MAX_CHARS} characters; beyond that the head and tail are kept, so print only what you need to read.`,
            inputSchema: runScriptInputSchema,
        });
    }

    protected async execute({ script, packages }: RunScriptInput): Promise<string> {
        try {
            const output = await this.preview.runScript({ script, packages });
            return truncateOutput(output, MAX_CHARS, "script output");
        } catch (cause) {
            throw new ScriptHarnessError(cause);
        }
    }
}
