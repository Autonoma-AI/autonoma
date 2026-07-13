export interface BuildRequest {
    appName: string;
    /** Directory passed to `railpack prepare` and used for Dockerfile resolution. */
    contextPath: string;
    /**
     * Docker build context root. Defaults to `contextPath` when omitted.
     *
     * Two callers set this:
     *   1. Dockerfile/auto-detect builds whose Dockerfile needs to see files
     *      outside the per-app dir (workspace deps visible during `bun
     *      install` inside the container build). Override only.
     *   2. Monorepo builds (`monorepoTool` set) - this is the monorepo root,
     *      so `railpack prepare` finds the workspace lockfile and `<pm> run
     *      turbo run build --filter=...` resolves the app correctly.
     */
    buildContext?: string;
    dockerfile?: string;
    // Target stage for a multi-stage user-authored Dockerfile (buildctl `--opt
    // target=`, like `docker build --target`). Only meaningful on the
    // on-disk-Dockerfile path; ignored by generated/monorepo/Railpack builds
    // (those are single-stage). Without it buildkit builds the last stage, which
    // is the wrong service when a Dockerfile ends with a worker/sidecar stage.
    target?: string;
    // Runtime-generated Dockerfile content. When set, the builder writes it to a
    // tmp dir and builds with `dockerfile.v0`, skipping the on-disk-Dockerfile,
    // monorepo, and Railpack paths. Build args are baked in as `ENV` lines by the
    // generator, so they are NOT also passed as `--opt build-arg`.
    generatedDockerfile?: string;
    buildArgs: Record<string, string>;
    imageTag: string;
    // Preview namespace this build belongs to (e.g. `preview-acme-bank-pr-42`).
    // Used as the key under which the builder streams live log output to the
    // build-log sink. Optional: when absent (or no sink is wired) the build runs
    // with only its pod-local temporary log file.
    namespace?: string;
    // Names the workspace build tool. Dispatched by the builder to select a
    // tool-specific build path (turbo+pnpm, nx, bazel, sbt, ... all need
    // different build invocations - a single boolean can't carry that
    // signal). Currently only "turbo" is implemented; adding more is a
    // case branch in the dispatcher plus a new build method. Requires
    // `buildContext` to be set (the monorepo root).
    monorepoTool?: "turbo";
    // Aborts the in-flight `buildctl` when a newer commit supersedes the deploy.
    // The builder passes it to `spawn`, so abort kills the child within seconds
    // instead of letting the build run to the full build timeout.
    signal?: AbortSignal;
}

export type BuildRuntime = "node" | "docker-image" | "unknown";

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
