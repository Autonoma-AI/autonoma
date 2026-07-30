/**
 * An error, fired during the execution of a tool call, which may be fixed by the agent itself
 * (i.e. by modifying the input and retrying the tool call).
 *
 * The agent will receive the error message as well as an optional "fix suggestion" string.
 */
export class FixableToolError extends Error {
    /** Suggest a fix for the given error. May be overridden in subclasses. */
    public suggestFix(): string | undefined {
        return undefined;
    }
}

/**
 * An error, fired during the execution of a tool call, which is fatal for the execution. Throwing one ends the
 * run: the loop stops at the end of the current step and the caller gets a `ToolCallFailedFatally` wrapping it.
 *
 * The throw alone is not what stops the loop - the AI SDK converts every exception a tool throws into a
 * `tool-error` content part and continues. `AgentTool` reports the failure to the loop at the throw site, so a
 * tool invoked outside that wrapper gets no such guarantee.
 */
export class FatalToolError extends Error {}
