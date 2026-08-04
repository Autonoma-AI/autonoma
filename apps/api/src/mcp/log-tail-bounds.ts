import { z } from "zod";

/**
 * How the MCP log tools bound a tail, and what they say when the tail was scoped
 * to a service that does not exist. Shared by both servers so the debug and
 * onboarding log tools cannot drift into different budgets or different answers
 * to the same mistake.
 */

/**
 * Byte budget for one log tool's result, and the ceiling a caller can raise it to.
 *
 * A line count is a poor bound on this surface: a build "line" is a whole output
 * chunk that can itself be many rendered lines, so a couple of hundred of them
 * routinely run past 50KB - enough to crowd out the code the agent is meant to
 * be reading. The byte budget is what actually caps the response; the line limit
 * stays as the coarse "how far back" knob.
 */
export const DEFAULT_LOG_BYTES = 60_000;
export const MAX_LOG_BYTES = 400_000;

export function logMaxBytesSchema() {
    return z
        .number()
        .int()
        .min(1_000)
        .max(MAX_LOG_BYTES)
        .optional()
        .describe(
            `Byte budget for the returned lines (default ${DEFAULT_LOG_BYTES}). Whole lines are dropped from the ` +
                `far end to fit and are never cut mid-line; raise it when \`dropped\` shows you are missing the ` +
                `part you need.`,
        );
}

/**
 * The error for a log query that named a service the preview does not have. It
 * lists the real names, because the alternative an agent falls into is retrying
 * the same guess or reporting that the service produced no output.
 */
export function unknownServiceMessage(unknownService: { requested: string; known: string[] }): string {
    const known = unknownService.known.length > 0 ? unknownService.known.join(", ") : "(none)";
    return (
        `This preview has no service named "${unknownService.requested}", so no logs were read - this is a wrong ` +
        `name, NOT an empty log window. Its services are: ${known}. Retry with one of those, or omit \`app\` to ` +
        `read every service at once.`
    );
}
