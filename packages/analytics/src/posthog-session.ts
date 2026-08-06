import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The browser's PostHog session id, bound to the async scope of the request it
 * arrived on, so `capture` can stamp `$session_id` without every service in the
 * call chain having to thread it down.
 *
 * Deliberately its own store rather than a group on the canonical observability
 * context. That schema is for Autonoma's own domain IDs - the ones that mean
 * something in our database and belong on every log line and Sentry tag - and a
 * PostHog session handle is neither: it is a vendor transport detail that only
 * the analytics client reads. Putting it there would also have meant opening an
 * observability scope for every tRPC request (there is none today) and
 * special-casing the flatten step, because PostHog needs the literal
 * `$session_id` key, not the `sessionId` the flattener would produce.
 *
 * This mirrors how `$sentry_trace_id` is already handled one file over: read
 * from ambient request state at capture time, not passed as an argument.
 */
const sessionStore = new AsyncLocalStorage<string>();

/**
 * Run `fn` with `sessionId` bound, so every PostHog event captured inside it -
 * at any depth - carries `$session_id` and resolves to that browser session's
 * recording.
 *
 * A missing id is the normal case, not an error: the CLI, Vercel's
 * machine-to-machine calls and every background job have no browser session.
 * Those simply run unbound and their events carry no session, so callers can
 * wrap unconditionally.
 */
export function withPostHogSession<T>(sessionId: string | undefined, fn: () => T): T {
    if (sessionId == null || sessionId === "") return fn();
    return sessionStore.run(sessionId, fn);
}

/** The bound session id, or undefined outside any {@link withPostHogSession} scope. */
export function getPostHogSessionId(): string | undefined {
    return sessionStore.getStore();
}
