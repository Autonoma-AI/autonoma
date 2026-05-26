export interface BuildRequest {
    appName: string;
    /** Directory passed to `railpack prepare` and used for Dockerfile resolution. */
    contextPath: string;
    /**
     * Docker build context root. Defaults to `contextPath` when omitted.
     * Set to the monorepo root when the app has workspace dependencies that
     * need to be visible during `bun install` inside the container build.
     */
    buildContext?: string;
    dockerfile?: string;
    buildArgs: Record<string, string>;
    imageTag: string;
    cacheKey: string;
}

export interface BuildResult {
    imageTag: string;
    durationMs: number;
    logUrl: string;
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
