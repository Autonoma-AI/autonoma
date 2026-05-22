import {
    type Scope,
    type SeverityLevel,
    type User,
    captureException,
    captureMessage,
    getCurrentScope,
    setTag,
    setUser,
    withScope,
} from "@sentry/node";
import type { ConsoleLogger } from "./console-logger";
import { consoleLogger } from "./console-logger";
import { env } from "./env";
import { flattenObservabilityContext, getObservabilityContext } from "./observability-context";
import { type HandledError, SentryLogger, asError } from "./sentry-logger";

export class BackendLogger extends SentryLogger {
    private bindings: Record<string, unknown> = {};

    constructor(structuredLogger: ConsoleLogger = consoleLogger, bindings: Record<string, unknown> = {}) {
        super(structuredLogger);
        this.bindings = bindings;
    }

    child(bindings: Record<string, unknown>): BackendLogger {
        const mergedBindings = { ...this.bindings, ...bindings };
        const childLogger = new BackendLogger(this.structuredLogger.child(bindings), mergedBindings);
        if (this.executionMode) {
            childLogger.executionMode = this.executionMode;
            childLogger.jobName = this.jobName ?? "";
        }
        return childLogger;
    }

    setTag(key: string, value: string): void {
        if (shouldUseSentry()) {
            setTag(key, value);
        }
        this.structuredLogger.debug({ tag: { key, value } }, `Setting tag: ${key}=${value}`);
    }

    captureMessage(message: string, level: SeverityLevel, extra?: Record<string, unknown>): void {
        this.captureLog(message, level, extra);
        if (shouldUseSentry()) {
            captureMessage(message, { level, ...(extra != null && { extra }) });
        }
    }

    captureLog(message: string, level: SeverityLevel, extra?: Record<string, unknown>, error?: HandledError): void {
        const flatObservability = flattenObservabilityContext(getObservabilityContext());
        const combinedData: Record<string, unknown> = shouldUseSentry()
            ? {
                  ...getCurrentScope().getScopeData().tags,
                  ...getCurrentScope().getScopeData().extra,
                  ...flatObservability,
                  ...this.bindings,
                  ...extra,
              }
            : { ...flatObservability, ...this.bindings, ...extra };

        if (shouldUseSentry()) {
            applyObservabilityTags(flatObservability);
            const errorObj: Error | undefined = error ? asError(error) : undefined;
            if (errorObj) {
                if ("digest" in errorObj) combinedData.digest = errorObj.digest as string;

                combinedData.error_name = errorObj.name;
                combinedData.error_message =
                    typeof errorObj.message === "string" ? errorObj.message : JSON.stringify(errorObj.message);
                combinedData.error_stack = errorObj.stack;

                // For Prisma errors
                const prismaError = error as { code?: string; meta?: unknown; clientVersion?: string };
                if (prismaError.code) combinedData.error_code = prismaError.code;
                if (prismaError.meta)
                    combinedData.error_meta =
                        typeof prismaError.meta === "string" ? prismaError.meta : JSON.stringify(prismaError.meta);
                if (prismaError.clientVersion) combinedData.error_client_version = prismaError.clientVersion;
            }
        }

        this.logAtLevel(level, combinedData, message);
    }

    withScope<T>(callback: (scope: Scope) => T): T {
        if (shouldUseSentry()) {
            return withScope((scope) => {
                for (const [key, value] of Object.entries(this.bindings)) scope.setExtra(key, value);

                return callback(scope);
            });
        }
        const mockScope = {
            setLevel: (level: string) =>
                this.structuredLogger.debug({ mockSentryLevel: level }, "Mock Sentry scope level set"),
            setExtra: (key: string, value: unknown) =>
                this.structuredLogger.debug({ mockSentryExtra: { key, value } }, "Mock Sentry extra set"),
            setTag: (key: string, value: string) =>
                this.structuredLogger.debug({ mockSentryTag: { key, value } }, "Mock Sentry tag set"),
        } as Scope;
        return callback(mockScope);
    }

    captureException(error: HandledError): void {
        const errorObject = asError(error);
        const flatObservability = flattenObservabilityContext(getObservabilityContext());
        if (shouldUseSentry()) {
            withScope((scope) => {
                for (const [key, value] of Object.entries(flatObservability)) {
                    if (value == null) continue;
                    scope.setTag(key, String(value));
                    scope.setExtra(key, value);
                }
                for (const [key, value] of Object.entries(this.bindings)) scope.setExtra(key, value);

                scope.setExtra("message", `Exception captured: ${errorObject?.message}`);
                captureException(error);
            });
        }
        this.structuredLogger.error(
            { err: error, ...flatObservability, ...this.bindings },
            `Exception captured: ${errorObject?.message}`,
        );
    }

    setUser(user: User): void {
        if (shouldUseSentry()) {
            setUser(user);
        }
        this.structuredLogger.debug({ sentryUser: user }, "Sentry user context set");
    }

    private logAtLevel(level: SeverityLevel, extra: Record<string, unknown>, message: string): void {
        switch (level) {
            case "fatal":
                this.structuredLogger.fatal(extra, message);
                break;
            case "error":
                this.structuredLogger.error(extra, message);
                break;
            case "warning":
                this.structuredLogger.warn(extra, message);
                break;
            case "info":
                this.structuredLogger.info(extra, message);
                break;
            case "debug":
                this.structuredLogger.debug(extra, message);
                break;
            default:
                this.structuredLogger.info(extra, message);
                break;
        }
    }
}

let _globalLoggerInstance: SentryLogger | null = null;

export const rootLogger = {
    get _instance(): SentryLogger {
        if (!_globalLoggerInstance) {
            _globalLoggerInstance = new BackendLogger(consoleLogger, {});
        }
        return _globalLoggerInstance;
    },

    info: (message: string, extra?: Record<string, unknown>) => rootLogger._instance.info(message, extra),
    error: (message: string, errorOrExtra?: unknown, extra?: Record<string, unknown>) =>
        rootLogger._instance.error(message, errorOrExtra, extra),
    warn: (message: string, extra?: Record<string, unknown>) => rootLogger._instance.warn(message, extra),
    debug: (message: string, extra?: Record<string, unknown>) => rootLogger._instance.debug(message, extra),
    captureError: (error: unknown, extra?: Record<string, unknown>, level?: SeverityLevel) =>
        rootLogger._instance.captureError(error, extra, level),
    child: (bindings: Record<string, unknown>) => rootLogger._instance.child(bindings),
    setExecutionMode: (mode: "job" | "service", jobName?: string) =>
        rootLogger._instance.setExecutionMode(mode, jobName),
    setUserContext: (user: { id: string; email: string; organizationId: string; role?: string }) =>
        rootLogger._instance.setUserContext(user),
    fatal: (message: string, errorOrExtra?: unknown, extra?: Record<string, unknown>) =>
        rootLogger._instance.fatal(message, errorOrExtra, extra),
};

export async function setSentryUserContext(user: {
    id: string;
    email: string;
    organizationId: string;
    role?: string;
    plan?: string;
}) {
    rootLogger._instance.info("Setting Sentry user context", { userContext: user });

    if (shouldUseSentry()) {
        setUser({
            id: user.id,
            email: user.email,
            username: user.email,
            ip_address: "{{auto}}",
            segment: user.organizationId,
        });

        setTag("organization_id", user.organizationId);
        if (user.role) setTag("user_role", user.role);
        if (user.plan) setTag("user_plan", user.plan);
    } else {
        console.log("Sentry user context skipped (not production)");
    }
}

function shouldUseSentry(): boolean {
    return env.NODE_ENV === "production";
}

function applyObservabilityTags(flat: Record<string, string | number>): void {
    for (const [key, value] of Object.entries(flat)) {
        setTag(key, String(value));
    }
}
