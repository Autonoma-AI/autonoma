import { NotFoundError } from "@autonoma/errors";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

/**
 * Shared result plumbing for the MCP servers (onboarding + debug). Both speak the
 * same lowest-common-denominator MCP content shape - a JSON payload as text, or an
 * error the agent can read instead of a transport 500 - so the mapping lives here
 * once. Keeping it shared means an improvement to how errors surface (e.g. the Zod
 * prettify below) reaches every tool on both servers, not just the one it was
 * written for.
 */

/** A tool result carrying a JSON payload as text (MCP's lowest-common-denominator content). */
export function jsonResult(payload: unknown): CallToolResult {
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

/** An error result the client's agent can read, instead of a transport-level 500. */
export function errorResult(message: string): CallToolResult {
    return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * A structured "nothing to act on yet" result (NOT an error). A tool returns this
 * shape when the resource it names has no live/available state, so the agent can
 * branch on `status: "unavailable"` instead of string-matching error text.
 */
export function unavailableResult(reason: string): CallToolResult {
    return jsonResult({ status: "unavailable", reason });
}

/**
 * Map a thrown error to a tool result. A NotFoundError (the repo/app/PR has no
 * environment, or the user isn't a member) is an expected "unavailable" state, not
 * a failure - return it structured. Anything else is a real error the agent sees.
 */
export function toToolResult(err: unknown): CallToolResult {
    if (err instanceof NotFoundError) return unavailableResult(err.message);
    return errorResult(describeError(err));
}

/**
 * Human-readable message for a tool failure, without leaking internals. A ZodError
 * (bad tool input, or a config document that fails validation) is flattened to a
 * per-field "path: message" list so the agent can see exactly what to fix and retry,
 * instead of a raw serialized error.
 */
export function describeError(err: unknown): string {
    if (err instanceof z.ZodError) return `Invalid input:\n${z.prettifyError(err)}`;
    if (err instanceof Error) return err.message;
    if (typeof err === "string") return err;
    return "Unexpected error";
}
