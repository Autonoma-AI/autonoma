export interface BuildRequest {
    appName: string;
    /** Directory used for Dockerfile resolution and as the default build context. */
    contextPath: string;
    /**
     * Docker build context root. Defaults to `contextPath` when omitted.
     *
     * Set for Dockerfile builds whose Dockerfile needs to see files outside the
     * per-app dir (workspace deps visible during `bun install` inside the
     * container build). Override only.
     */
    buildContext?: string;
    dockerfile?: string;
    // Target stage for a multi-stage user-authored Dockerfile (buildctl `--opt
    // target=`, like `docker build --target`). Only meaningful on the
    // on-disk-Dockerfile path; ignored by generated builds (those are
    // single-stage). Without it buildkit builds the last stage, which is the
    // wrong service when a Dockerfile ends with a worker/sidecar stage.
    target?: string;
    // Runtime-generated Dockerfile content. When set, the builder writes it to a
    // tmp dir and builds with `dockerfile.v0`, skipping the on-disk-Dockerfile
    // path. Build args are baked in as `ENV` lines by the generator, so they are
    // NOT also passed as `--opt build-arg`.
    generatedDockerfile?: string;
    buildArgs: Record<string, string>;
    imageTag: string;
    // Stable per (org, repo, app) BuildKit registry-cache reference (see
    // `buildPreviewCacheReference`), shared across every PR/commit for that
    // app. When set, the build imports from and exports back to this ref
    // (`--import-cache` / `--export-cache type=registry`) so a cold Job can
    // reuse layers a previous build already pushed. Omitted (e.g. tests)
    // disables cache import/export entirely.
    cacheRef?: string;
    // Preview namespace this build belongs to (e.g. `preview-acme-bank-pr-42`).
    // Used as the key under which the builder streams live log output to the
    // build-log sink. Optional: when absent (or no sink is wired) the build runs
    // with only its pod-local temporary log file.
    namespace?: string;
    // Deploy identity, stamped onto the ephemeral buildkit Job/pod as labels so
    // an operator can find the build pod for a given repo/PR/app with a
    // `kubectl -l` selector.
    repo?: string;
    pr?: number;
    // Aborts the in-flight `buildctl` when a newer commit supersedes the deploy.
    // The builder passes it to `spawn`, so abort kills the child within seconds
    // instead of letting the build run to the full build timeout.
    signal?: AbortSignal;
}

/**
 * The kind of artifact a build produced. Every build now goes through BuildKit
 * from a Dockerfile (user-authored or generated), so the only value is
 * `docker-image`.
 */
export type BuildRuntime = "docker-image";

export interface BuildResult {
    imageTag: string;
    durationMs: number;
    runtime: BuildRuntime;
}

/**
 * Thrown by a Builder when an app's build fails. The captured build output
 * lives in the build-log sink (Grafana Loki), keyed by the request's
 * namespace - viewers read it from there rather than from this error.
 */
export class BuildError extends Error {
    readonly isTransient: boolean;
    /**
     * A safe, human-facing failure reason to record/show the user, when the raw
     * `message` (kept technical for Sentry/structured logs) would be opaque or
     * misleading - e.g. a platform outage that is not the user's fault. Only the
     * surfacing boundary (recorded reason, build-log echo) substitutes this;
     * internal logging always uses `message`.
     */
    readonly userFacingMessage?: string;

    constructor(message: string, options?: { cause?: unknown; isTransient?: boolean; userFacingMessage?: string }) {
        super(message, options?.cause != null ? { cause: options.cause } : undefined);
        this.name = "BuildError";
        this.isTransient = options?.isTransient ?? false;
        if (options?.userFacingMessage != null) this.userFacingMessage = options.userFacingMessage;
    }
}

/**
 * A build whose `AbortSignal` fired - the build was cancelled, NOT a build
 * failure. The signal fires for two reasons: a supersede (a newer commit
 * cancelled this run) or a runner shutdown. Neither is a deploy failure.
 *
 * It extends `BuildError` so the builder's existing `instanceof BuildError`
 * handling still applies (never retried - `isTransient` stays false). But it is
 * a distinct type so callers can tell "we cancelled this on purpose" apart from
 * "the build genuinely broke": `buildOneApp` re-throws it instead of swallowing
 * it into a `failed` app outcome, so the build activity bails before
 * `recordBuildFinished` runs. The `buildPreviewImages` activity then converts it
 * into a Temporal `CancelledFailure` so the deploy workflow's `isCancellation()`
 * branch (not the failure finalizer) handles it - leaving the environment row
 * untouched instead of stamping a healthy preview `failed`.
 */
export class BuildAbortedError extends BuildError {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "BuildAbortedError";
    }
}

export interface Builder {
    build(request: BuildRequest): Promise<BuildResult>;
}
