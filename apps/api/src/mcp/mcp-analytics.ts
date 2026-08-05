import type { PostHogAnalytics } from "@autonoma/analytics";
import {
    extendObservabilityContext,
    getObservabilityContext,
    type Logger,
    logger as rootLogger,
    withObservabilityContext,
} from "@autonoma/logger";

/** PostHog event emitted once per MCP tool invocation. */
const MCP_TOOL_CALLED_EVENT = "mcp.tool_called";
/** The PostHog group type MCP usage is attributed to - one org per customer. */
const ORGANIZATION_GROUP = "organization";

/**
 * The minimal MCP tool-result shape this layer reads. `content` is required (every
 * result carries it) so the type is not a weak, all-optional type - which would let
 * TypeScript accept unrelated objects; `isError` is what tells success from failure.
 */
interface ToolOutcome {
    content: unknown;
    isError?: boolean;
}

/**
 * Per-request analytics for one MCP server connection. Emits a `mcp.tool_called`
 * PostHog event for every tool invocation - tagged with the tool, the resolved
 * customer organization (as a PostHog group so usage breaks down per customer),
 * success, and latency - making MCP usage observable per customer and per tool.
 *
 * Org attribution is indirect on purpose: a tool only learns its organization
 * once it resolves the application it was called with, deep inside the handler.
 * Rather than thread that id back out of every handler, {@link track} opens a fresh
 * observability scope around the handler, {@link observeOrgResolution} and
 * {@link observeTargetResolution} record the org into it as the application is
 * resolved, and {@link track} reads it back to tag the event. A resolver that is
 * handed to tools unwrapped leaves every one of them attributed to no org.
 *
 * The scope is opened per call (not per HTTP request), so attribution never
 * depends on the transport propagating an outer async context, and one tool's org
 * can't leak into another's event within the same request.
 */
export class McpAnalytics {
    private readonly logger: Logger;

    constructor(
        private readonly analytics: PostHogAnalytics,
        private readonly serverName: string,
        private readonly userId: string,
    ) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    /**
     * Wrap the per-repo org resolver so whichever organization a tool resolves is
     * bound to the request's observability context - flowing into that tool's logs
     * and its `mcp.tool_called` event without the handler passing the id back.
     */
    observeOrgResolution(
        resolveOrg: (repoFullName: string) => Promise<string>,
    ): (repoFullName: string) => Promise<string> {
        return async (repoFullName) => {
            const organizationId = await resolveOrg(repoFullName);
            extendObservabilityContext({ organization: { organizationId } });
            return organizationId;
        };
    }

    /**
     * Same as {@link observeOrgResolution} but for a resolver that answers with a context
     * carrying the org alongside the rest of what it resolved. The input is whatever identity
     * that resolver takes - a `repoFullName`, or the either-form target input - so every way a
     * tool names an application can be observed through one wrapper. Records `organizationId`
     * into the scope and passes the resolved context through untouched.
     */
    observeTargetResolution<TInput, TResolved extends { organizationId: string }>(
        resolve: (input: TInput) => Promise<TResolved>,
    ): (input: TInput) => Promise<TResolved> {
        return async (input) => {
            const resolved = await resolve(input);
            extendObservabilityContext({ organization: { organizationId: resolved.organizationId } });
            return resolved;
        };
    }

    /**
     * Run a tool handler in a fresh observability scope, then emit `mcp.tool_called`
     * with the outcome. Opening the scope here (rather than relying on one bound
     * upstream) means the org an inner `observeOrgResolution` records is always read
     * back from a live frame this call owns - independent of whether the transport
     * preserved the caller's async context, and isolated from sibling tool calls in
     * the same request. Success is read off the returned result's `isError` flag (an
     * errored result is a handled failure, not a thrown one); a thrown error is
     * recorded as a failure and re-thrown. An analytics failure never breaks the call.
     */
    async track<T extends ToolOutcome>(toolName: string, run: () => Promise<T>): Promise<T> {
        return withObservabilityContext({}, async () => {
            const startedAt = Date.now();
            try {
                const result = await run();
                this.record(toolName, startedAt, result.isError !== true);
                return result;
            } catch (err) {
                this.record(toolName, startedAt, false);
                throw err;
            }
        });
    }

    private record(toolName: string, startedAt: number, success: boolean): void {
        const organizationId = getObservabilityContext().organization?.organizationId;
        const properties: Record<string, unknown> = {
            server: this.serverName,
            tool: toolName,
            success,
            durationMs: Date.now() - startedAt,
            organizationId,
        };
        const groups = organizationId != null ? { [ORGANIZATION_GROUP]: organizationId } : undefined;

        try {
            this.analytics.capture(this.userId, MCP_TOOL_CALLED_EVENT, properties, groups);
        } catch (err) {
            this.logger.warn("Failed to capture mcp.tool_called", { extra: { toolName, success }, err });
        }
    }
}
