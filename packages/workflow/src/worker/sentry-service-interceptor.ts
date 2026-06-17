import {
    type ObservabilityContext,
    extendObservabilityContext,
    logger,
    pickObservabilityContext,
    withObservabilityContext,
} from "@autonoma/logger";
import * as Sentry from "@sentry/node";
import type { ActivityInterceptorsFactory } from "@temporalio/worker";
import { loadGenerationObservabilityContext } from "../observability/load-generation-context";
import { loadRunObservabilityContext } from "../observability/load-run-context";
import { loadSnapshotObservabilityContext } from "../observability/load-snapshot-context";

/**
 * Creates an activity interceptor that:
 *
 * 1. Sets Sentry tags with service + Temporal workflow IDs so issues are filterable.
 * 2. Binds an observability context (Temporal info + derived snapshot IDs) to the
 *    activity's async scope via AsyncLocalStorage. Every `logger.*` call inside
 *    the activity automatically carries the same canonical fields.
 * 3. If the activity input is a plain object with a `snapshotId` property, loads
 *    the full snapshot context (branchId, applicationId, organizationId, etc.)
 *    once at activity entry and merges it into the ALS frame.
 */
export function createSentryServiceInterceptor(
    serviceMap: Record<string, string>,
    fallbackService: string,
): ActivityInterceptorsFactory {
    return (ctx) => {
        const activityType = ctx.info.activityType;
        const service = serviceMap[activityType] ?? fallbackService;

        const tags: Record<string, string> = {
            service,
            activity: activityType,
            workflow_id: ctx.info.workflowExecution.workflowId,
            workflow_run_id: ctx.info.workflowExecution.runId,
        };

        const observability: ObservabilityContext = {
            temporal: {
                workflowId: ctx.info.workflowExecution.workflowId,
                temporalRunId: ctx.info.workflowExecution.runId,
                workflowType: ctx.info.workflowType,
                taskQueue: ctx.info.taskQueue,
                activityType,
                activityId: ctx.info.activityId,
                attempt: ctx.info.attempt,
            },
        };

        return {
            inbound: {
                async execute(input, next) {
                    return Sentry.withIsolationScope(async (isolationScope) => {
                        for (const [k, v] of Object.entries(tags)) isolationScope.setTag(k, v);

                        return Sentry.withScope(async (currentScope) => {
                            for (const [k, v] of Object.entries(tags)) currentScope.setTag(k, v);

                            const fromArgs = extractCanonicalFieldsFromArgs(input.args);
                            return withObservabilityContext(mergeShallow(observability, fromArgs), async () => {
                                await maybeBootstrapEntityContext(input.args);
                                try {
                                    return await next(input);
                                } catch (error) {
                                    // A cancelled activity is expected control flow, not a crash
                                    // (e.g. a newer commit superseded a preview deploy, aborting the
                                    // in-flight build). Log it at warn so it stays out of the
                                    // fatal/error stream, then re-throw unchanged.
                                    if (ctx.cancellationSignal.aborted) {
                                        logger.warn(`Activity cancelled: ${activityType}`, {
                                            extra: { error: String(error) },
                                        });
                                        throw error;
                                    }
                                    if (error instanceof Error) {
                                        logger.fatal(`Activity failed: ${activityType}`, error);
                                    } else {
                                        logger.fatal(`Activity failed: ${activityType}`, {
                                            extra: { error: String(error) },
                                        });
                                    }
                                    throw error;
                                }
                            });
                        });
                    });
                },
            },
        };
    };
}

function mergeShallow(a: ObservabilityContext, b: ObservabilityContext): ObservabilityContext {
    const merged: ObservabilityContext = { ...a };
    for (const [key, value] of Object.entries(b)) {
        if (value == null) continue;
        const existing = Reflect.get(merged, key);
        Object.assign(merged, {
            [key]: existing != null && typeof existing === "object" ? { ...existing, ...value } : value,
        });
    }
    return merged;
}

/**
 * Bootstrap the full observability chain (snapshot + branch + application +
 * organization) when the activity input carries an ID we can resolve. Tried
 * in order of specificity, stopping at the first match so we issue at most
 * one extra Prisma query per activity entry.
 *
 *   1. snapshotId  -> Snapshot graph directly
 *   2. runId       -> Run -> Snapshot graph
 *   3. testGenerationId -> TestGeneration -> Snapshot graph
 *
 * No-op when the input has none of these. Never throws.
 */
async function maybeBootstrapEntityContext(args: readonly unknown[]): Promise<void> {
    const ids = extractEntityIds(args);

    try {
        if (ids.snapshotId != null) {
            extendObservabilityContext(await loadSnapshotObservabilityContext(ids.snapshotId));
            return;
        }
        if (ids.runId != null) {
            extendObservabilityContext(await loadRunObservabilityContext(ids.runId));
            return;
        }
        if (ids.testGenerationId != null) {
            extendObservabilityContext(await loadGenerationObservabilityContext(ids.testGenerationId));
            return;
        }
    } catch (error) {
        logger.warn("Failed to bootstrap observability context from activity input", {
            extra: { error: String(error), ids },
        });
    }
}

interface EntityIds {
    snapshotId?: string;
    runId?: string;
    testGenerationId?: string;
}

function extractEntityIds(args: readonly unknown[]): EntityIds {
    const out: EntityIds = {};
    for (const arg of args) {
        if (typeof arg !== "object" || arg == null) continue;
        if (out.snapshotId == null && "snapshotId" in arg) {
            const value: unknown = arg.snapshotId;
            if (typeof value === "string" && value.length > 0) out.snapshotId = value;
        }
        if (out.runId == null && "runId" in arg) {
            const value: unknown = arg.runId;
            if (typeof value === "string" && value.length > 0) out.runId = value;
        }
        if (out.testGenerationId == null && "testGenerationId" in arg) {
            const value: unknown = arg.testGenerationId;
            if (typeof value === "string" && value.length > 0) out.testGenerationId = value;
        }
    }
    return out;
}

/**
 * Collect any canonical observability fields whose names appear directly in the
 * activity input. This lets activities that take e.g. `{ iterationId }` get
 * `iterationId` into ALS without having to call extendObservabilityContext.
 */
function extractCanonicalFieldsFromArgs(args: readonly unknown[]): ObservabilityContext {
    let out: ObservabilityContext = {};
    for (const arg of args) {
        out = { ...out, ...pickObservabilityContext(arg) };
    }
    return out;
}
