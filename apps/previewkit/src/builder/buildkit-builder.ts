import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { BuildLogSink } from "@autonoma/logger/build-log-sink";
import { logger as rootLogger, type Logger } from "../logger";
import {
    BuildAbortedError,
    BuildError,
    type Builder,
    type BuildRequest,
    type BuildResult,
    type BuildRuntime,
} from "./builder";
import type { BuildJobIdentity } from "./buildkit-job-manager";
import { EcrRegistryClient } from "./ecr-client";
import { BUILD_MESSAGES } from "./messages";

const BUILD_MAX_RETRIES = 3;
const BUILDKIT_RETRY_DELAY_MS = 5000;
// Keep only the tail of each stream for transient error detection.
// 8 KB is enough for any error string without buffering the full build log.
const TAIL_SIZE = 8192;
/**
 * Substrings that, when found in buildctl's stdout/stderr tail, indicate the
 * remote buildkitd disappeared mid-build rather than the build itself
 * failing. Most of these surface when the ephemeral buildkitd pod is evicted
 * by kubelet, OOMKilled, or otherwise terminated. Retrying provisions a fresh
 * Job, so these failures are safe to retry. False positives here just burn one
 * retry attempt, so we lean inclusive.
 *
 * Exported for tests only.
 */
export const TRANSIENT_NETWORK_PATTERNS: readonly RegExp[] = [
    /graceful_stop/,
    /connection refused/,
    /connection reset/,
    /broken pipe/,
    /unexpected EOF/,
    /rpc error.*code = Unavailable/,
    /transport.*error while dialing/,
    /transport is closing/,
    /no such host/,
    // Session loss: a terminated or resource-starved build pod drops the
    // buildctl<->buildkitd gRPC
    // session (or its healthcheck times out) mid-build. Bare "context deadline
    // exceeded" is deliberately NOT listed - it also surfaces for genuine
    // in-build timeouts (slow registry pulls, user RUN steps printing their own
    // gRPC errors), where a retry just replays a deterministic failure. buildkitd
    // appends that cause to the session error anyway ("no active session for
    // <id>: context deadline exceeded"), so the anchored forms below already
    // match the deadline variants worth retrying.
    /no active session for/,
    /session healthcheck failed/,
    /failed to get session/,
    // Pre-build worker enumeration against an unhealthy buildkitd pod: the
    // TCP connection is accepted then dropped before the gRPC handshake (the
    // pod closes the connection), so buildctl
    // never even lists the daemon's workers - it fails with `failed to list
    // workers: Unavailable: ... use of closed network connection`. Anchored on
    // buildctl's own `failed to list workers` framing (never emitted by a user's
    // RUN step) rather than the bare Go/gRPC connection strings, which could
    // appear in user build output and mislabel a real app failure as ours.
    /failed to list workers/,
];

interface BuildKitJobLifecycle {
    provision(signal?: AbortSignal, identity?: BuildJobIdentity): Promise<BuildKitInstance>;
    release(instance: { name: string }): Promise<void>;
}

interface BuildKitInstance {
    name: string;
    host: string;
}

interface BuildKitAttempt {
    instance?: BuildKitInstance;
}

type GetBuildKitHost = () => Promise<string>;

interface BuildKitBuilderOptions {
    jobManager: BuildKitJobLifecycle;
    buildTimeoutMs: number;
    /** Delay between fresh-Job retries. Defaults to five seconds; injectable so
     * retry lifecycle tests do not sleep. */
    retryDelayMs?: number;
    /** When set, every build-output chunk is mirrored to this sink (keyed by
     *  `request.namespace`) for live streaming and durable history, in
     *  addition to the temporary local log. */
    logSink?: BuildLogSink;
}

interface BuildDispatchResult {
    imageTag: string;
    runtime: BuildRuntime;
}

/**
 * Minimal writable surface the build methods need from their log stream. The
 * raw file WriteStream satisfies it directly; TeeBuildLog wraps one to also fan
 * each chunk into the build-log sink for live streaming + durable history.
 */
interface BuildLogWriter {
    write(chunk: string | Uint8Array): boolean;
    end(callback: () => void): void;
}

/** Tees build output to both the on-disk log file and the build-log sink. */
class TeeBuildLog implements BuildLogWriter {
    constructor(
        private readonly file: WriteStream,
        private readonly sink: BuildLogSink,
        private readonly namespace: string,
        private readonly app: string,
    ) {}

    write(chunk: string | Uint8Array): boolean {
        const ok = this.file.write(chunk);
        const message = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        // Fire-and-forget: the sink swallows + logs its own errors, so a Loki
        // hiccup can never block or fail the build it is mirroring.
        void this.sink.append(this.namespace, { kind: "log", app: this.app, message });
        return ok;
    }

    end(callback: () => void): void {
        this.file.end(callback);
    }
}

/**
 * Builds container images from a Dockerfile.
 * The source of the Dockerfile is the only variable:
 *
 * 1. A generated Dockerfile (framework preset / `runtime` escape hatch) - built
 *    with `buildctl` and `dockerfile.v0`.
 * 2. A user-authored Dockerfile (the `dockerfile` field, or one on disk at the
 *    app directory) - built the same way.
 * 3. Neither - a hard, actionable `BuildError`. There is no autodetection
 *    fallback: an app must carry a `build` block or a Dockerfile.
 *
 * All paths push directly to the registry via buildctl's image exporter.
 *
 * Per-build stdout+stderr is written to a pod-local temp file (removed after
 * the attempt) and mirrored to the build-log sink (Grafana Loki) when one is
 * wired - that sink is where viewers read build logs from.
 */
export class BuildKitBuilder implements Builder {
    private readonly jobManager: BuildKitJobLifecycle;
    private readonly buildTimeoutMs: number;
    private ecr: EcrRegistryClient;
    private readonly retryDelayMs: number;
    private readonly logSink?: BuildLogSink;
    private readonly logger: Logger;

    constructor(options: BuildKitBuilderOptions) {
        this.jobManager = options.jobManager;
        this.buildTimeoutMs = options.buildTimeoutMs;
        this.ecr = new EcrRegistryClient();
        this.retryDelayMs = options.retryDelayMs ?? BUILDKIT_RETRY_DELAY_MS;
        this.logSink = options.logSink;
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    async build(request: BuildRequest): Promise<BuildResult> {
        const start = Date.now();
        this.logger.info("Starting build", {
            extra: { app: request.appName, imageTag: request.imageTag },
        });
        try {
            await this.ecr.ensureRepo(request.imageTag);
        } catch (err) {
            const repositoryError = err instanceof Error ? err : new Error(String(err));
            this.logger.error("Failed to prepare build image repository", repositoryError, {
                extra: { app: request.appName },
            });
            throw err;
        }

        for (let attempt = 1; attempt <= BUILD_MAX_RETRIES; attempt++) {
            // A cancellation between attempts must not create another Job.
            if (request.signal?.aborted === true) {
                throw new BuildAbortedError("build aborted between attempts (cancelled)");
            }
            const isLastAttempt = attempt === BUILD_MAX_RETRIES;
            const logPath = this.buildLogPath(request.imageTag);
            const fileStream = createWriteStream(logPath, { flags: "a" });
            // Mirror output to the build-log sink when one is wired and this
            // build is tied to a namespace; otherwise write to the file alone.
            const logStream: BuildLogWriter =
                this.logSink != null && request.namespace != null
                    ? new TeeBuildLog(fileStream, this.logSink, request.namespace, request.appName)
                    : fileStream;

            const buildkitAttempt: BuildKitAttempt = {};
            const getBuildkitHost = async (): Promise<string> => {
                const existingInstance = buildkitAttempt.instance;
                if (existingInstance != null) return existingInstance.host;

                const instance = await this.jobManager.provision(request.signal, {
                    appName: request.appName,
                    namespace: request.namespace,
                    repo: request.repo,
                    pr: request.pr,
                });
                buildkitAttempt.instance = instance;
                return instance.host;
            };
            try {
                const build = await this.dispatchBuild(request, getBuildkitHost, logStream);
                const instance = buildkitAttempt.instance;
                if (instance == null) {
                    throw new BuildError("build completed without provisioning buildkit infrastructure");
                }
                const durationMs = Date.now() - start;
                this.logger.info("Build complete", {
                    extra: {
                        app: request.appName,
                        imageTag: build.imageTag,
                        runtime: build.runtime,
                        durationMs,
                        builderJob: instance.name,
                    },
                });
                // Structured build-speed marker (best-effort telemetry). Lets
                // LogQL chart per-build duration over the same Loki stream the
                // raw output already flows to.
                if (request.namespace != null) {
                    void this.logSink?.markFinished?.(request.namespace, {
                        app: request.appName,
                        builder: "ephemeral",
                        durationMs,
                        host: instance.host,
                    });
                }
                return { imageTag: build.imageTag, durationMs, runtime: build.runtime };
            } catch (err) {
                // A supersede abort is not a build failure: re-throw it as-is so
                // it is neither retried nor wrapped by `annotateWithLogs` (which
                // would erase the type), and `buildOneApp` can recognize it.
                if (err instanceof BuildAbortedError) {
                    this.logger.info("Build aborted", { extra: { app: request.appName } });
                    throw err;
                }
                if (err instanceof BuildError && err.isTransient && !isLastAttempt) {
                    const instance = buildkitAttempt.instance;
                    if (instance != null) {
                        const released = await this.releaseInstance(instance, request.appName);
                        if (released) buildkitAttempt.instance = undefined;
                    }
                    await this.onTransientError(err, attempt, request.appName, logStream, request.signal);
                    continue;
                }
                const buildError = err instanceof Error ? err : new Error(String(err));
                // `userFacingMessage` is set only when the failure is our
                // infrastructure (retries exhausted on a transient outage, or a
                // permanent infra fault) - never for a client's own broken build
                // (a non-zero buildctl exit). So it cleanly separates "the
                // buildkit job died on our side" from "the client's build
                // failed": the former pages us, the latter is just a log.
                if (err instanceof BuildError && err.userFacingMessage != null) {
                    logStream.write(`\n[previewkit] ${err.userFacingMessage}\n`);
                    this.logger.captureError(buildError, {
                        app: request.appName,
                        repo: request.repo,
                        pr: request.pr,
                        namespace: request.namespace,
                        imageTag: request.imageTag,
                        attempts: BUILD_MAX_RETRIES,
                        fault_type: "buildkit_infrastructure",
                    });
                } else {
                    this.logger.error("Build failed", buildError, { extra: { app: request.appName } });
                }
                throw err;
            } finally {
                await this.closeLog(logStream).catch((closeErr) => {
                    this.logger.warn("Failed to close build log stream", {
                        extra: { app: request.appName, closeErr },
                    });
                });
                const instance = buildkitAttempt.instance;
                if (instance != null) {
                    await this.releaseInstance(instance, request.appName);
                }
                await rm(logPath, { force: true }).catch((rmErr) => {
                    this.logger.warn("Failed to remove build log temp file", {
                        extra: { app: request.appName, logPath, rmErr },
                    });
                });
            }
        }

        throw new BuildError("buildkit build loop exited without returning");
    }

    private dispatchBuild(
        request: BuildRequest,
        getBuildkitHost: GetBuildKitHost,
        logStream: BuildLogWriter,
    ): Promise<BuildDispatchResult> {
        if (request.generatedDockerfile != null) {
            return this.buildWithGeneratedDockerfile(request, request.generatedDockerfile, getBuildkitHost, logStream);
        }
        const dockerfilePath = this.resolveDockerfile(request.contextPath, request.dockerfile);
        if (dockerfilePath != null) {
            return this.buildWithBuildctl(request, dockerfilePath, getBuildkitHost, logStream);
        }
        // No generated Dockerfile, no user Dockerfile: the build is undetermined.
        const undeterminedBuild = new BuildError(
            `App "${request.appName}" cannot be built: it has no \`build\` block in its preview config ` +
                `and no Dockerfile in its app directory. Add a \`build\` block (a framework preset or the ` +
                `\`runtime\` escape hatch) to the app, or commit a Dockerfile. PreviewKit no longer `,
        );
        this.logger.fatal("App cannot be built: no build block and no Dockerfile", undeterminedBuild, {
            extra: { app: request.appName, contextPath: request.contextPath },
        });
        throw undeterminedBuild;
    }

    private async onTransientError(
        err: BuildError,
        attempt: number,
        appName: string,
        logStream: BuildLogWriter,
        signal?: AbortSignal,
    ): Promise<void> {
        this.logger.warn("BuildKit transient error, retrying", {
            extra: {
                app: appName,
                attempt,
                maxRetries: BUILD_MAX_RETRIES,
                message: err.message,
            },
        });
        logStream.write(
            `\n[previewkit] BuildKit transient error - retrying (attempt ${attempt}/${BUILD_MAX_RETRIES})...\n`,
        );
        // Brief delay before the next isolated build attempt.
        try {
            await delay(this.retryDelayMs, undefined, { signal });
        } catch (err) {
            if (signal?.aborted === true) {
                this.logger.info("Build retry delay aborted", { extra: { app: appName } });
                throw new BuildAbortedError("build aborted between attempts (cancelled)", { cause: err });
            }
            const delayError = err instanceof Error ? err : new Error(String(err));
            this.logger.error("Build retry delay failed", delayError, { extra: { app: appName } });
            throw err;
        }
    }

    private async releaseInstance(instance: { name: string }, appName: string): Promise<boolean> {
        try {
            await this.jobManager.release(instance);
            return true;
        } catch (err) {
            const releaseError = err instanceof Error ? err : new Error(String(err));
            this.logger.error("Failed to release buildkit Job", releaseError, {
                extra: { app: appName, builderJob: instance.name },
            });
            return false;
        }
    }

    /**
     * Returns the resolved Dockerfile path, or undefined if none exists.
     */
    private resolveDockerfile(contextPath: string, dockerfile?: string): string | undefined {
        if (dockerfile) {
            const resolved = resolve(contextPath, dockerfile);
            if (!existsSync(resolved)) {
                throw new Error(`Specified Dockerfile not found: ${dockerfile} (resolved to ${resolved})`);
            }
            return resolved;
        }

        const defaultPath = join(contextPath, "Dockerfile");
        if (existsSync(defaultPath)) {
            return defaultPath;
        }

        return undefined;
    }

    private async buildWithBuildctl(
        request: BuildRequest,
        dockerfilePath: string,
        getBuildkitHost: GetBuildKitHost,
        logStream: BuildLogWriter,
    ): Promise<BuildDispatchResult> {
        const dockerfileDir = dirname(dockerfilePath);
        const dockerfileName = basename(dockerfilePath);
        const ecrAuth = await this.ecr.getAuth(request.imageTag);
        const dockerConfigDir = ecrAuth != null ? await this.ecr.writeDockerConfig(ecrAuth) : undefined;
        const buildContext = request.buildContext ?? request.contextPath;

        try {
            const buildkitHost = await getBuildkitHost();
            this.logger.info("Building with BuildKit (Dockerfile)", {
                extra: {
                    app: request.appName,
                    dockerfile: dockerfilePath,
                    target: request.target,
                    imageTag: request.imageTag,
                    buildkitHost,
                },
            });
            const args = [
                "--addr",
                buildkitHost,
                "build",
                "--progress",
                "plain",
                "--frontend",
                "dockerfile.v0",
                "--local",
                `context=${buildContext}`,
                "--local",
                `dockerfile=${dockerfileDir}`,
                "--opt",
                `filename=${dockerfileName}`,
                "--opt",
                "platform=linux/amd64",
                "--output",
                `type=image,name=${request.imageTag},push=true,compression=zstd`,
            ];

            // Select a stage in a multi-stage Dockerfile. Without it buildkit
            // builds the last stage, which is the wrong service when a Dockerfile
            // ends with a worker/sidecar stage after the deployable one.
            if (request.target != null) {
                args.push("--opt", `target=${request.target}`);
            }

            // Every build arg is passed both as `--opt build-arg` (for Dockerfiles
            // that declare `ARG <key>` and read it as an env var) AND as a BuildKit
            // secret (for Dockerfiles that consume it via `RUN --mount=type=secret,
            // id=<key>`, reading /run/secrets/<key>). Without the secret, mount-based
            // Dockerfiles get an empty file and fail. buildctl reads the secret value
            // from our env. Mirrors the generated-Dockerfile path.
            const buildSecretEnv: Record<string, string> = {};
            for (const [key, value] of Object.entries(request.buildArgs)) {
                args.push("--opt", `build-arg:${key}=${value}`);
                args.push("--secret", `id=${key},env=${key}`);
                buildSecretEnv[key] = value;
            }

            const extraEnv: Record<string, string> = { ...buildSecretEnv };
            if (dockerConfigDir != null) {
                extraEnv["DOCKER_CONFIG"] = dockerConfigDir;
            }

            await this.exec("buildctl", args, extraEnv, logStream, request.signal);
            return { imageTag: request.imageTag, runtime: "docker-image" };
        } finally {
            if (dockerConfigDir != null) {
                await rm(dockerConfigDir, { recursive: true }).catch((err: unknown) => {
                    this.logger.warn("Failed to clean up docker config dir", {
                        extra: { dockerConfigDir, err },
                    });
                });
            }
        }
    }

    /**
     * Builds from a Dockerfile generated by `generateDockerfile` (framework-preset
     * builds). The content is written to a tmp dir that becomes buildctl's
     * `dockerfile` local; the app/repo dir is the `context` local. Build args are
     * pre-baked as `ENV` lines by the generator, so they are NOT passed as
     * `--opt build-arg`. Image push behavior matches `buildWithBuildctl`.
     */
    private async buildWithGeneratedDockerfile(
        request: BuildRequest,
        dockerfileContent: string,
        getBuildkitHost: GetBuildKitHost,
        logStream: BuildLogWriter,
    ): Promise<BuildDispatchResult> {
        const ecrAuth = await this.ecr.getAuth(request.imageTag);
        const dockerConfigDir = ecrAuth != null ? await this.ecr.writeDockerConfig(ecrAuth) : undefined;
        const dockerfileDir = join(tmpdir(), `previewkit-generated-dockerfile-${randomUUID()}`);
        await mkdir(dockerfileDir, { recursive: true });

        try {
            await writeFile(join(dockerfileDir, "Dockerfile"), dockerfileContent);
            const buildkitHost = await getBuildkitHost();
            this.logger.info("Building with generated Dockerfile", {
                extra: {
                    app: request.appName,
                    imageTag: request.imageTag,
                    buildkitHost,
                    dockerfileBytes: dockerfileContent.length,
                },
            });

            const args = [
                "--addr",
                buildkitHost,
                "build",
                "--progress",
                "plain",
                "--frontend",
                "dockerfile.v0",
                "--local",
                `context=${request.contextPath}`,
                "--local",
                `dockerfile=${dockerfileDir}`,
                "--opt",
                "platform=linux/amd64",
                "--output",
                `type=image,name=${request.imageTag},push=true,compression=zstd`,
            ];

            const extraEnv: Record<string, string> = {};
            if (dockerConfigDir != null) {
                extraEnv["DOCKER_CONFIG"] = dockerConfigDir;
            }

            await this.exec("buildctl", args, extraEnv, logStream, request.signal);
            return { imageTag: request.imageTag, runtime: "docker-image" };
        } finally {
            await rm(dockerfileDir, { recursive: true }).catch((err) =>
                this.logger.warn("Failed to clean up generated dockerfile dir", {
                    extra: { dockerfileDir, err },
                }),
            );
            if (dockerConfigDir != null) {
                await rm(dockerConfigDir, { recursive: true }).catch((err) =>
                    this.logger.warn("Failed to clean up docker config dir", {
                        extra: { dockerConfigDir, err },
                    }),
                );
            }
        }
    }

    private exec(
        command: string,
        args: string[],
        extraEnv: Record<string, string>,
        logStream: BuildLogWriter,
        signal?: AbortSignal,
    ): Promise<void> {
        return new Promise((resolvePromise, reject) => {
            logStream.write(`\n$ ${command} ${args.join(" ")}\n`);

            const child = spawn(command, args, {
                env: { ...process.env, ...extraEnv },
                timeout: this.buildTimeoutMs,
                ...(signal != null ? { signal } : {}),
            });

            child.on("error", (err: NodeJS.ErrnoException) => {
                // An aborted spawn surfaces as an AbortError here. Reject
                // non-transiently so the retry loop does not relaunch a build we
                // are deliberately cancelling.
                if (err.name === "AbortError" || signal?.aborted === true) {
                    reject(new BuildAbortedError(`${command} aborted (build cancelled)`, { cause: err }));
                    return;
                }
                const message = err.code === "ENOENT" ? `${command} binary not found` : err.message;
                reject(new BuildError(message, { cause: err }));
            });

            // Pipe both streams to the log file; do NOT end the destination when
            // a source ends, since multiple exec() calls share the same stream.
            // Tee both streams into small tail buffers to detect transient BuildKit
            // errors - buildctl writes the graceful_stop message to stdout in
            // --progress plain mode, but to stderr in other modes.
            let stdoutTail = "";
            child.stdout.on("data", (chunk: Buffer) => {
                logStream.write(chunk);
                stdoutTail = (stdoutTail + chunk.toString()).slice(-TAIL_SIZE);
            });
            let stderrTail = "";
            child.stderr.on("data", (chunk: Buffer) => {
                logStream.write(chunk);
                stderrTail = (stderrTail + chunk.toString()).slice(-TAIL_SIZE);
            });

            child.on("close", (code) => {
                if (signal?.aborted === true) {
                    reject(new BuildAbortedError(`${command} aborted (build cancelled)`));
                } else if (child.killed) {
                    reject(new BuildError(`${command} timed out after ${this.buildTimeoutMs / 1000}s`));
                } else if (code === 0) {
                    resolvePromise();
                } else {
                    const combined = stdoutTail + stderrTail;
                    const isTransient = TRANSIENT_NETWORK_PATTERNS.some((p) => p.test(combined));
                    // Keep `message` technical for Sentry/structured logs; a
                    // transient failure is a platform outage, so attach the
                    // prebaked user-facing reason separately for the surfacing
                    // boundary to prefer over the opaque `exited with code N`.
                    reject(
                        new BuildError(`${command} exited with code ${code}`, {
                            isTransient,
                            ...(isTransient ? { userFacingMessage: BUILD_MESSAGES.infrastructureUnavailable } : {}),
                        }),
                    );
                }
            });
        });
    }

    /** Closes the per-attempt log stream, flushing the temp file and ending the sink tee. */
    private async closeLog(logStream: BuildLogWriter): Promise<void> {
        await new Promise<void>((res) => logStream.end(() => res()));
    }

    private buildLogPath(imageTag: string): string {
        const safe = imageTag.replace(/[^A-Za-z0-9_.-]/g, "_");
        return join(tmpdir(), `previewkit-build-log-${safe}-${Date.now()}.log`);
    }
}
