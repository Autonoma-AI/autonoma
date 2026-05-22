import { logger as backendLogger } from "@autonoma/logger";
import type { LogLevel, LogMetadata, Logger as TemporalLogger } from "@temporalio/worker";

/**
 * Forwards every Temporal SDK log call to our BackendLogger so that workflow
 * logs (and Temporal's own diagnostic chatter) flow to Sentry / PostHog /
 * console via the same pipeline as activity logs.
 *
 * Why this exists: workflow code is deterministic and cannot call Sentry
 * (Sentry generates UUIDs / opens HTTP connections / reads time). Temporal's
 * `log` from `@temporalio/workflow` is replay-safe; it funnels calls through a
 * sink that the worker (non-deterministic code) handles via this logger. So
 * workflow code logs through Temporal's logger, and we forward to Sentry here.
 *
 * The metadata Temporal injects automatically:
 *   { namespace, taskQueue, workflowId, runId, workflowType, sdkComponent }
 *
 * We remap `runId` -> `temporalRunId` to avoid colliding with our canonical
 * domain `runId` (a Run row).
 */
export const temporalSdkLogger: TemporalLogger = {
    trace(message, meta) {
        backendLogger.debug(message, normalize(meta));
    },
    debug(message, meta) {
        backendLogger.debug(message, normalize(meta));
    },
    info(message, meta) {
        backendLogger.info(message, normalize(meta));
    },
    warn(message, meta) {
        backendLogger.warn(message, normalize(meta));
    },
    error(message, meta) {
        const { error, ...rest } = normalize(meta);
        if (error instanceof Error) {
            backendLogger.error(message, error, rest);
            return;
        }
        backendLogger.error(message, rest);
    },
    log(level: LogLevel, message, meta) {
        switch (level) {
            case "TRACE":
            case "DEBUG":
                backendLogger.debug(message, normalize(meta));
                return;
            case "INFO":
                backendLogger.info(message, normalize(meta));
                return;
            case "WARN":
                backendLogger.warn(message, normalize(meta));
                return;
            case "ERROR": {
                const { error, ...rest } = normalize(meta);
                if (error instanceof Error) {
                    backendLogger.error(message, error, rest);
                    return;
                }
                backendLogger.error(message, rest);
                return;
            }
        }
    },
};

/**
 * Lift Temporal's auto-injected fields into our canonical names so they end up
 * in Sentry tags and PostHog properties under the same keys activity logs use.
 */
function normalize(meta: LogMetadata | undefined): Record<string, unknown> {
    if (meta == null) return {};
    const { runId, namespace, ...rest } = meta;
    const normalized: Record<string, unknown> = { ...rest };
    if (typeof runId === "string") normalized.temporalRunId = runId;
    if (namespace !== undefined)
        normalized.extra = { ...(typeof rest.extra === "object" && rest.extra !== null ? rest.extra : {}), namespace };
    return normalized;
}
