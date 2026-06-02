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
    buildArgs: Record<string, string>;
    imageTag: string;
    cacheKey: string;
    // Names the workspace build tool. Dispatched by the builder to select a
    // tool-specific build path (turbo+pnpm, nx, bazel, sbt, ... all need
    // different build invocations - a single boolean can't carry that
    // signal). Currently only "turbo" is implemented; adding more is a
    // case branch in the dispatcher plus a new build method. Requires
    // `buildContext` to be set (the monorepo root).
    monorepoTool?: "turbo";
}

export type BuildRuntime = "node" | "docker-image" | "unknown";

export interface BuildResult {
    imageTag: string;
    durationMs: number;
    logUrl: string;
    runtime: BuildRuntime;
}

/**
 * Thrown by a Builder when an app's build fails. Carries the URL of the
 * captured build log (when the builder managed to upload it) so callers can
 * surface a clickable link without having to grep the error message.
 *
 * `logUrl` is optional because log upload itself can fail (S3 unreachable,
 * empty log file, etc.); in that case `cause` carries the upload failure
 * for diagnostics and the build error message stays the only signal.
 */
export class BuildError extends Error {
    readonly logUrl?: string;
    readonly isTransient: boolean;

    constructor(message: string, options?: { logUrl?: string; cause?: unknown; isTransient?: boolean }) {
        super(message, options?.cause != null ? { cause: options.cause } : undefined);
        this.name = "BuildError";
        this.isTransient = options?.isTransient ?? false;
        if (options?.logUrl != null) this.logUrl = options.logUrl;
    }
}

export interface Builder {
    build(request: BuildRequest): Promise<BuildResult>;
}
