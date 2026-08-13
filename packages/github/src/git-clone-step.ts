import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Logger } from "@autonoma/logger";
import { z } from "zod";

const execFileAsync = promisify(execFile);

/**
 * Runs a single git subprocess in the repository-clone path, times it, bounds it,
 * and translates any failure into a structured, token-redacted `GitCommandError`.
 *
 * This is the mechanism half of `OctokitGitHubInstallationClient.cloneRepository`;
 * the client owns the policy (which steps run, in what order, with which budgets).
 * Kept out of the Octokit REST client so the git plumbing has a focused home.
 */

/** The distinct git invocations the clone path makes, in the order they can fail. */
export type GitStep = "clone" | "checkout-head" | "fetch-head" | "cat-file-base" | "fetch-base";

/** `child_process.execFile` rejection shape, narrowed to the fields we surface. Timeout kills set `code` to `null`, so every field is nullish-tolerant. */
const execErrorSchema = z.object({
    killed: z.boolean().nullish(),
    signal: z.string().nullish(),
    code: z.union([z.number(), z.string()]).nullish(),
    stderr: z.string().nullish(),
});

/**
 * Build an environment for `git` that supplies the installation token as an
 * `Authorization` header via env-based config (`GIT_CONFIG_*`). This avoids
 * putting the token in the process argv or the cloned remote URL, so it can't
 * leak through git's stderr or an `execFile` error.
 */
export function buildAuthenticatedGitEnv(token: string): NodeJS.ProcessEnv {
    const basicAuth = Buffer.from(`x-access-token:${token}`).toString("base64");
    return {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraHeader",
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${basicAuth}`,
    };
}

/** Replace every occurrence of `secret` in `text` with `***`. */
function redactToken(text: string, secret: string): string {
    if (secret.length === 0) return text;
    return text.split(secret).join("***");
}

/**
 * Replace every occurrence of `secret` in an error's message with `***`. Used as
 * defense in depth on the non-git error paths (git steps already throw a redacted
 * `GitCommandError`) so a failure can never surface the installation token.
 */
export function redactSecret(error: unknown, secret: string): Error {
    const message = error instanceof Error ? error.message : String(error);
    return new Error(redactToken(message, secret));
}

/** Structured facts about a failed git step, carried alongside the message for logging. */
export interface GitFailureDetails {
    step: GitStep;
    /** True when our timeout killed the child - the budget elapsed and Node sent the kill signal. */
    timedOut: boolean;
    /** True when the child died by any signal, including one we did NOT send (e.g. the OOM killer's SIGKILL, where `timedOut` is false). */
    killed: boolean;
    signal?: string;
    /** Set when git exited with a numeric status (e.g. 128 for `not our ref`). */
    exitCode?: number;
    /** Set when the failure was a spawn-level error code (e.g. `ENOENT`, `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`). */
    errorCode?: string;
    elapsedMs: number;
}

/**
 * A git command in the clone path that failed. Its `message` is self-describing -
 * which step, whether it timed out, exit code, elapsed time - so the causes that
 * hide in this bucket stay distinguishable once the message is the only thing
 * persisted to `analysis_job.failure_reason`. `details` carries the same facts as
 * structured fields for logging/Sentry, before the error crosses the Temporal
 * boundary (which keeps only the message).
 */
export class GitCommandError extends Error {
    constructor(
        message: string,
        public readonly details: GitFailureDetails,
    ) {
        super(message);
        this.name = "GitCommandError";
    }
}

/**
 * The base SHA a clone was asked to fetch is not on the remote (`not our ref`) - a commit orphaned by a
 * force-push or GC. Raised by `cloneRepository` INSTEAD of a generic clone failure so a caller can recover to a
 * reachable base rather than failing the whole run. A transient fetch failure (a timeout) is deliberately NOT
 * this error - it stays a {@link GitCommandError} so it surfaces and retries.
 *
 * The message carries only the SHA (a hash, never a secret), so it needs no token redaction.
 */
export class UnreachableBaseShaError extends Error {
    constructor(public readonly baseSha: string) {
        super(`Base SHA ${baseSha} is unreachable on the remote (not our ref)`);
        this.name = "UnreachableBaseShaError";
    }
}

/**
 * git `upload-pack` stderr signatures for a ref the remote will not serve. These are GitHub's wording; this
 * client is GitHub-only, but a different git server rejects an unadvertised want with other wording (e.g. `Server
 * does not allow request for unadvertised object`) this would NOT match, so do not reuse it verbatim against a
 * non-GitHub remote. Patterns, not literals, so `.some(...)` is the right membership check.
 */
const UNREACHABLE_REF_PATTERNS = [/not our ref/i, /couldn't find remote ref/i];

/**
 * Whether a failed git step means the remote does not have the ref (recoverable), as opposed to a transient
 * failure. A step our timeout killed - or that died by any signal - never completed the ref negotiation, so it is
 * transient by definition; only a genuine non-zero exit whose (redacted) stderr, carried in the message, names
 * the missing ref counts.
 */
export function isUnreachableRefError(error: GitCommandError): boolean {
    if (error.details.timedOut || error.details.killed) return false;
    return UNREACHABLE_REF_PATTERNS.some((pattern) => pattern.test(error.message));
}

interface GitStepContext {
    step: GitStep;
    /** The git subcommand (`args[0]`), used as the human verb in the message. */
    subcommand: string;
    elapsedMs: number;
    timeoutMs: number;
    token: string;
}

/** Translate a raw `execFile` rejection into a redacted, self-describing `GitCommandError`. */
export function toGitCommandError(error: unknown, ctx: GitStepContext): GitCommandError {
    const { step, subcommand, elapsedMs, timeoutMs, token } = ctx;
    const parsed = execErrorSchema.safeParse(error);
    const fields = parsed.success ? parsed.data : {};
    const signal = fields.signal ?? undefined;
    // Node sets `killed` only when it sent the kill signal itself - i.e. our timeout fired.
    const timedOut = fields.killed === true;
    // A signal death from anyone, including the OOM killer's SIGKILL (where Node's `killed` stays false).
    const killed = signal != null;
    const exitCode = typeof fields.code === "number" ? fields.code : undefined;
    const errorCode = typeof fields.code === "string" ? fields.code : undefined;
    const stderr = redactToken(fields.stderr ?? "", token).trim();
    const stderrSuffix = stderr.length > 0 ? `: ${stderr}` : "";

    const message = timedOut
        ? `git ${subcommand} timed out [step=${step}, elapsed=${elapsedMs}ms, budget=${timeoutMs}ms, signal=${signal ?? "SIGTERM"}]`
        : killed
          ? `git ${subcommand} killed by ${signal} [step=${step}, elapsed=${elapsedMs}ms]${stderrSuffix}`
          : `git ${subcommand} failed [step=${step}, exit=${exitCode ?? errorCode ?? "unknown"}, elapsed=${elapsedMs}ms]${stderrSuffix}`;

    // Redact the fully assembled message too (stderr is already redacted above):
    // deliberate defense-in-depth so a token can never reach a caller's logs even
    // if a future edit interpolates a token-bearing value into the message.
    return new GitCommandError(redactToken(message, token), {
        step,
        timedOut,
        killed,
        signal,
        exitCode,
        errorCode,
        elapsedMs,
    });
}

export interface GitStepOptions {
    timeoutMs: number;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    maxBufferBytes?: number;
}

/**
 * Run one git step, timing it and translating any failure into a structured,
 * token-redacted `GitCommandError`. Logs the elapsed time on success so the
 * timeout/depth budget can be evaluated against real durations. Failures are left
 * for the caller to log (a recoverable checkout/cat-file miss is expected control
 * flow, not an error), except the one that ultimately escapes.
 */
export async function runGitStep(
    step: GitStep,
    args: [string, ...string[]],
    options: GitStepOptions,
    token: string,
    stepLogger: Logger,
): Promise<void> {
    const startedAt = Date.now();
    try {
        await execFileAsync("git", args, {
            cwd: options.cwd,
            timeout: options.timeoutMs,
            env: options.env,
            maxBuffer: options.maxBufferBytes,
        });
        stepLogger.debug("git step completed", { extra: { step, elapsedMs: Date.now() - startedAt } });
    } catch (error) {
        throw toGitCommandError(error, {
            step,
            subcommand: args[0],
            elapsedMs: Date.now() - startedAt,
            timeoutMs: options.timeoutMs,
            token,
        });
    }
}
