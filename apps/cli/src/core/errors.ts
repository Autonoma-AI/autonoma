import { APICallError, RetryError, LoadAPIKeyError, InvalidPromptError, NoSuchModelError } from "ai";
import { getRunId } from "./analytics";
import { CLI_VERSION } from "./version";

export class AgentError extends Error {
    constructor(
        message: string,
        public readonly phase: string,
        public override readonly cause?: unknown,
    ) {
        super(message);
        this.name = "AgentError";
    }
}

export class ToolError extends Error {
    constructor(
        message: string,
        public readonly toolName: string,
        public override readonly cause?: unknown,
    ) {
        super(message);
        this.name = "ToolError";
    }
}

export interface RetryOptions {
    maxRetries: number;
    baseDelayMs: number;
    maxDelayMs: number;
    shouldRetry?: (error: unknown, attempt: number) => boolean;
}

const DEFAULT_RETRY: RetryOptions = {
    maxRetries: 3,
    baseDelayMs: 1000,
    maxDelayMs: 30_000,
};

export async function withRetry<T>(fn: () => Promise<T>, options: Partial<RetryOptions> = {}): Promise<T> {
    const opts = { ...DEFAULT_RETRY, ...options };

    for (let attempt = 1; attempt <= opts.maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            const isLast = attempt === opts.maxRetries;
            const shouldRetry = opts.shouldRetry?.(error, attempt) ?? isRetryable(error);

            if (isLast || !shouldRetry) throw error;

            const delay = Math.min(opts.baseDelayMs * 2 ** (attempt - 1) + Math.random() * 500, opts.maxDelayMs);
            await sleep(delay);
        }
    }

    throw new Error("Unreachable");
}

function isRetryable(error: unknown): boolean {
    if (error instanceof Error) {
        const msg = error.message.toLowerCase();
        return (
            msg.includes("rate limit") ||
            msg.includes("429") ||
            msg.includes("503") ||
            msg.includes("timeout") ||
            msg.includes("econnreset") ||
            msg.includes("econnrefused")
        );
    }
    return false;
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * True when an error represents the user deliberately stopping the run - a
 * Ctrl+C or a "cancel" choice at an interactive prompt (clack throws/returns a
 * cancel that we surface as a "... cancelled" error). These are not failures:
 * callers should save progress and exit quietly, and must NOT report them to
 * error tracking, where they'd masquerade as bugs.
 */
export function isUserCancellation(err: unknown): boolean {
    return err instanceof Error && /\bcancell?ed\b/i.test(err.message);
}

/**
 * A failure we recognize and can explain. When `describeKnownError` returns one,
 * the caller prints the friendly title + hint and suppresses the raw stack -
 * the stack is library-internal noise that wouldn't help the user act.
 */
export interface KnownError {
    title: string;
    hint: string;
}

/**
 * Collapse an exception to every message in its cause chain, lowercased, so a
 * matcher can look for a substring regardless of how deeply the SDK wrapped it.
 */
function chainMessages(err: unknown): string {
    const parts: string[] = [];
    let cur: unknown = err;
    for (let depth = 0; cur != null && depth < 10; depth++) {
        if (cur instanceof Error) {
            parts.push(cur.message);
            cur = cur.cause;
        } else {
            parts.push(String(cur));
            break;
        }
    }
    return parts.join(" ← ").toLowerCase();
}

/**
 * Walk the cause chain to the first APICallError and return its HTTP status.
 * The agent layer wraps provider errors in an AgentError (and the AI SDK may
 * wrap them in a RetryError), so the status we key friendly messages off of is
 * almost never on the top-level error - we have to dig for it.
 */
function apiStatusOf(err: unknown): number | undefined {
    let cur: unknown = err;
    for (let depth = 0; cur != null && depth < 10; depth++) {
        if (APICallError.isInstance(cur)) return cur.statusCode;
        if (RetryError.isInstance(cur)) {
            cur = cur.lastError;
            continue;
        }
        cur = cur instanceof Error ? cur.cause : undefined;
    }
    return undefined;
}

/**
 * Translate the failures we've seen in the wild into an actionable one-liner.
 * These are almost always configuration problems, not bugs - a raw stack just
 * buries the fix. Returns null for anything we don't recognize, so the caller
 * falls back to printing the full stack + a support reference.
 */
export function describeKnownError(err: unknown): KnownError | undefined {
    const msg = chainMessages(err);
    const status = apiStatusOf(err);

    const looksLikeAuth =
        msg.includes("missing authentication header") ||
        msg.includes("no auth credentials") ||
        msg.includes("not authenticated") ||
        msg.includes("unauthorized") ||
        msg.includes("user not found") ||
        status === 401 ||
        status === 403;
    if (looksLikeAuth) {
        return {
            title: "Autonoma rejected the request - your API token looks missing or invalid.",
            hint: "Launch the planner from the Autonoma app, or set a valid AUTONOMA_API_TOKEN (create one at https://autonoma.app/settings/api-keys).",
        };
    }

    // The managed proxy returns 402 (out_of_credits) once the org's credit
    // balance is exhausted. Point straight at billing.
    if (
        msg.includes("out_of_credits") ||
        msg.includes("insufficient") ||
        msg.includes("credits") ||
        msg.includes("quota") ||
        status === 402
    ) {
        return {
            title: "You're out of Autonoma credits.",
            hint: "Top up your credits at https://autonoma.app, then re-run.",
        };
    }

    if (
        NoSuchModelError.isInstance(err) ||
        msg.includes("model_not_allowed") ||
        msg.includes("not a valid model") ||
        msg.includes("no endpoints found") ||
        msg.includes("model not found")
    ) {
        return {
            title: "The requested model isn't available.",
            hint: "Check OPENROUTER_MODEL, or unset it to use the default.",
        };
    }

    if (msg.includes("rate limit") || msg.includes("too many requests") || status === 429) {
        return {
            title: "Autonoma is rate-limiting this account.",
            hint: "Wait a minute and re-run. If it persists, reach out to support.",
        };
    }

    // A 404/502/503 reaching the CLI is a problem with the managed planner
    // service, not the user's input. A bare 404 means the proxy route wasn't
    // found at the API host - the proxy is disabled or undeployed, or a custom
    // AUTONOMA_API_URL points somewhere without it (the exact failure that once
    // surfaced as a raw "Not Found"). A 502/503 means the proxy is reachable but
    // its upstream or config is failing. Real bad-model/bad-request failures come
    // back as 400 and are handled above, so this family is always "our side -
    // retry or contact support", never something the user can fix by re-running.
    if (status === 404 || status === 502 || status === 503 || msg.includes("llm_proxy_unconfigured")) {
        return {
            title: "The Autonoma planner service is temporarily unavailable.",
            hint: "This is on our side, not your setup - retry in a minute, and contact support if it keeps happening. If you set a custom AUTONOMA_API_URL, confirm it points at a host running the planner.",
        };
    }

    return undefined;
}

/**
 * A short support reference block printed under an unrecognized failure. The
 * `ref` is this run's id - it ties the printed error to the exact `$exception`
 * event(s) in analytics, so a user only has to paste one short string for us to
 * find their full stack and context.
 */
export function supportReference(extra: Record<string, string | undefined> = {}): string {
    const fields: Record<string, string | undefined> = {
        ref: getRunId(),
        version: CLI_VERSION,
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        ...extra,
    };
    return Object.entries(fields)
        .filter(([, v]) => v != null && v !== "")
        .map(([k, v]) => `${k}: ${v}`)
        .join("  ");
}

/**
 * Render an exception with its full stack and cause chain, so users can
 * copy-paste it when reporting an issue. The CLI is open source - stacks
 * reference CLI internals, never the user's source code.
 */
export function formatException(err: unknown): string {
    if (!(err instanceof Error)) return String(err);
    let out = err.stack ?? `${err.name}: ${err.message}`;
    if (err.cause != null) {
        out += `\nCaused by: ${formatException(err.cause)}`;
    }
    return out;
}

export type AgentErrorClass = "timeout" | "transient" | "fatal";

// 402 is the managed proxy's hard stop (out of credits, or the free planner
// usage cap reached). Retrying can't refill a balance mid-run, so fail fast and
// let describeKnownError surface the billing hint instead of burning retries.
const FATAL_STATUS_CODES = new Set([400, 401, 402, 403, 404, 422]);

// Recoverable provider quirks that arrive disguised as fatal client errors
// (usually a 400). They are not malformed requests we can fix - a fresh retry,
// or falling back to a different model, gets past them - so they must be
// classified "transient" before the status-code check marks them fatal.
//
// "corrupted thought signature": Google's Gemini reasoning models (via
// OpenRouter) intermittently reject a request when the reasoning-token
// signature carried over from a prior turn fails to validate. It returns as a
// 400 but is transient - retrying or switching to a non-reasoning fallback
// model clears it.
const RETRYABLE_PROVIDER_QUIRKS = ["corrupted thought signature"];

const TRANSIENT_MESSAGE_PATTERNS = [
    "econnreset",
    "econnrefused",
    "etimedout",
    "socket hang up",
    "fetch failed",
    "network",
    "overloaded",
    "rate limit",
    "too many requests",
    "429",
    "500",
    "502",
    "503",
    "529",
];

/**
 * Classify an error thrown by an agent run so the caller can decide whether to
 * retry. Everything unknown defaults to "transient" - retries are bounded and
 * a wrong "fatal" kills the step, while a wrong "transient" only costs a few
 * retries before the failure surfaces anyway.
 */
export function classifyAgentError(err: unknown): AgentErrorClass {
    const message = err instanceof Error ? err.message : String(err);
    const msg = message.toLowerCase();

    if (msg.includes("timed out") || msg.includes("timeout") || msg.includes("abort")) {
        return "timeout";
    }

    // Check known recoverable quirks across the whole cause chain first, so a 400
    // status from the underlying APICallError doesn't pre-empt them as fatal.
    const chain = chainMessages(err);
    if (RETRYABLE_PROVIDER_QUIRKS.some((pattern) => chain.includes(pattern))) {
        return "transient";
    }

    if (APICallError.isInstance(err)) {
        if (err.statusCode != null && FATAL_STATUS_CODES.has(err.statusCode)) return "fatal";
        return "transient";
    }

    if (LoadAPIKeyError.isInstance(err) || InvalidPromptError.isInstance(err) || NoSuchModelError.isInstance(err)) {
        return "fatal";
    }

    if (RetryError.isInstance(err)) {
        if (err.reason === "errorNotRetryable" && err.lastError !== err) {
            return classifyAgentError(err.lastError);
        }
        return "transient";
    }

    if (TRANSIENT_MESSAGE_PATTERNS.some((pattern) => msg.includes(pattern))) {
        return "transient";
    }

    return "transient";
}
