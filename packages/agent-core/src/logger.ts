/**
 * Minimal structured-logger contract the agent loop depends on.
 *
 * Deliberately narrow: `@autonoma/agent-core` must stay free of backend infra (`@autonoma/logger`
 * -> `@sentry/node`) so it can be bundled into the published planner CLI. Any richer logger - the
 * backend's Sentry-backed `SentryLogger`, or a CLI adapter routing into a debug channel - is
 * structurally assignable to this interface and injected via {@link setDefaultLogger} or
 * `AgentConfig.logger`.
 */
export interface Logger {
    child(bindings: Record<string, unknown>): Logger;
    info(message: string, extra?: Record<string, unknown>): void;
    warn(message: string, extra?: Record<string, unknown>): void;
    error(message: string, errorOrExtra?: unknown, extra?: Record<string, unknown>): void;
    fatal(message: string, errorOrExtra?: unknown, extra?: Record<string, unknown>): void;
}

class NoopLogger implements Logger {
    child(): Logger {
        return this;
    }
    info(): void {}
    warn(): void {}
    error(): void {}
    fatal(): void {}
}

/** A logger that discards everything. The default until {@link setDefaultLogger} is called. */
export const noopLogger: Logger = new NoopLogger();

let defaultLogger: Logger = noopLogger;

/**
 * Register the process-wide default logger used by agents that don't inject their own via
 * `AgentConfig.logger`. `@autonoma/ai` calls this once at import with its `@autonoma/logger`
 * singleton; the CLI passes a debug-channel adapter (or leaves it as the silent default).
 */
export function setDefaultLogger(logger: Logger): void {
    defaultLogger = logger;
}

/** The currently-registered default logger. Silent {@link noopLogger} unless overridden. */
export function getDefaultLogger(): Logger {
    return defaultLogger;
}
