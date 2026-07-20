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
 * An error, fired during the execution of a tool call, which is fatal for the execution. This means
 * that execution will be stopped immediately and the error will be propagated to the caller of the
 * agent loop.
 */
export class FatalToolError extends Error {}
