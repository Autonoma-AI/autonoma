import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { BuildLogSink } from "@autonoma/logger/build-log-sink";
import { logger } from "../logger";
import { type BuildQueue, BuildQueueTimeoutError, type BuildSlot } from "./build-queue";
import {
    BuildAbortedError,
    BuildError,
    type Builder,
    type BuildRequest,
    type BuildResult,
    type BuildRuntime,
} from "./builder";
import { EcrRegistryClient } from "./ecr-client";
import { detectNonNodeRootManifests, planTurboMonorepoBuild, provisionRailpackNodeOverride } from "./turbo-monorepo";

const BUILD_MAX_RETRIES = 3;
const BUILDKIT_RETRY_DELAY_MS = 5000;
// Keep only the tail of each stream for transient error detection.
// 8 KB is enough for any error string without buffering the full build log.
const TAIL_SIZE = 8192;
// Prebaked, user-facing message for a build that failed because the buildkit
// pool was unreachable/overloaded rather than because of the app's code or
// config. It replaces the raw `buildctl exited with code N` (and the cryptic
// gRPC dump) as the recorded failure reason and is echoed into the build log,
// so the user is not left thinking a transient platform outage was their fault.
// Kept static on purpose - no AI diagnosis - so it works even when the model
// pipeline is unavailable.
const BUILD_INFRA_UNAVAILABLE_MESSAGE =
    "The build service was temporarily unavailable and could not start your build. " +
    "This is a platform issue on our side, not a problem with your app or its configuration. " +
    "Please retry the deploy; if it keeps happening, contact support.";

/**
 * Substrings that, when found in buildctl's stdout/stderr tail, indicate the
 * remote buildkitd disappeared mid-build rather than the build itself
 * failing. Most of these surface when the warm buildkitd pod serving the
 * build is evicted by kubelet (node pressure), OOMKilled, or rolled by a
 * deploy - all cases where retrying is the right move: the retry re-acquires
 * an admission-queue slot and dials a healthy pool pod (or, on the unqueued
 * fallback path, kube-proxy re-routes the Service connection). False
 * positives here just burn one retry attempt, so we lean inclusive.
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
    // Session loss: a CPU-starved pool pod drops the buildctl<->buildkitd gRPC
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
    // Pre-build worker enumeration against an overloaded/unhealthy pool pod: the
    // TCP connection is accepted then dropped before the gRPC handshake (the
    // saturated pod, at its memory ceiling, closes the connection), so buildctl
    // never even lists the daemon's workers - it fails with `failed to list
    // workers: Unavailable: ... use of closed network connection`. Anchored on
    // buildctl's own `failed to list workers` framing (never emitted by a user's
    // RUN step) rather than the bare Go/gRPC connection strings, which could
    // appear in user build output and mislabel a real app failure as ours.
    /failed to list workers/,
];

interface BuildKitBuilderOptions {
    /** The warm buildkitd pool's Service endpoint (tcp://host:1234). With no
     *  queue wired this is what every build dials as buildctl's `--addr`; with
     *  a queue it is the fail-open fallback, since admitted builds dial the
     *  granting pod directly (deployment/buildkit/buildkitd-warm.yaml). */
    warmHost: string;
    buildTimeoutMs: number;
    /** When set, every build-output chunk is mirrored to this sink (keyed by
     *  `request.namespace`) for live streaming + durable history, in addition
     *  to the disk + S3 log. Optional so builds work unchanged when no sink is
     *  configured. */
    logSink?: BuildLogSink;
    /** Admission queue for the warm pool. Each attempt acquires a slot on a
     *  specific pool pod before spawning buildctl (bounding concurrent builds
     *  per pod) and releases it after. Optional: absent means every build
     *  dials `warmHost` immediately, exactly as before the queue existed. */
    queue?: BuildQueue;
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
 * Builds container images using two strategies:
 *
 * 1. If the app has a Dockerfile - build with `buildctl` and `dockerfile.v0`
 * 2. Otherwise - run `railpack prepare` from the app directory.
 *
 * All paths push directly to the registry via buildctl's image exporter.
 *
 * Per-build stdout+stderr is written to a pod-local temp file (removed after
 * the attempt) and mirrored to the build-log sink (Grafana Loki) when one is
 * wired - that sink is where viewers read build logs from.
 */
export class BuildKitBuilder implements Builder {
    private readonly warmHost: string;
    private readonly buildTimeoutMs: number;
    private ecr: EcrRegistryClient;
    private readonly logSink?: BuildLogSink;
    private readonly queue?: BuildQueue;

    constructor(options: BuildKitBuilderOptions) {
        this.warmHost = options.warmHost;
        this.buildTimeoutMs = options.buildTimeoutMs;
        this.ecr = new EcrRegistryClient();
        this.logSink = options.logSink;
        this.queue = options.queue;
    }

    async build(request: BuildRequest): Promise<BuildResult> {
        const start = Date.now();
        await this.ecr.ensureRepo(request.imageTag);
        let queueWaitMs = 0;

        for (let attempt = 1; attempt <= BUILD_MAX_RETRIES; attempt++) {
            // A cancellation between attempts must not start another attempt.
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

            // Acquired fresh per attempt: a retry after a pool pod died must
            // re-queue and land on a LIVE pod, not redial the corpse.
            let slot: BuildSlot | undefined;
            try {
                slot = await this.acquireSlot(request, logStream);
                queueWaitMs += slot.waitMs;
                const build = await this.dispatchBuild(request, slot.addr, logStream);
                const durationMs = Date.now() - start;
                logger.info("Build complete", {
                    app: request.appName,
                    imageTag: build.imageTag,
                    runtime: build.runtime,
                    durationMs,
                    queueWaitMs,
                    pod: slot.pod,
                });
                // Structured build-speed marker (best-effort telemetry). Lets
                // LogQL chart per-build duration over the same Loki stream the
                // raw output already flows to.
                if (request.namespace != null) {
                    void this.logSink?.markFinished?.(request.namespace, {
                        app: request.appName,
                        builder: "warm",
                        durationMs,
                        queueWaitMs,
                        host: slot.addr,
                    });
                }
                return { imageTag: build.imageTag, durationMs, runtime: build.runtime };
            } catch (err) {
                // A supersede abort is not a build failure: re-throw it as-is so
                // it is neither retried nor wrapped by `annotateWithLogs` (which
                // would erase the type), and `buildOneApp` can recognize it.
                if (err instanceof BuildAbortedError) {
                    throw err;
                }
                // A saturation timeout never ran buildctl, so the success-path
                // finish marker can't cover it - emit the dedicated saturation
                // marker so the clearest queue-overload signal is visible in
                // build telemetry (best-effort, like the other markers). The
                // failed acquire returned no slot, so its wait rides the error.
                if (err instanceof BuildQueueTimeoutError && request.namespace != null) {
                    void this.logSink?.markQueueTimeout?.(request.namespace, {
                        app: request.appName,
                        queueWaitMs: queueWaitMs + err.waitedMs,
                    });
                }
                if (err instanceof BuildError && err.isTransient && !isLastAttempt) {
                    await this.onTransientError(err, attempt, request.appName, logStream);
                    continue;
                }
                // Retries exhausted on a platform outage: close the log with the
                // prebaked explanation so the user reading the build log sees the
                // failure was our infrastructure, not their build.
                if (err instanceof BuildError && err.userFacingMessage != null) {
                    logStream.write(`\n[previewkit] ${err.userFacingMessage}\n`);
                }
                throw err;
            } finally {
                // Free the pool slot before the (possibly retried) next attempt
                // queues again, then close the per-attempt log stream (flushes
                // the temp file and ends the sink tee) before removing the file.
                await slot?.release();
                await this.closeLog(logStream).catch((closeErr) => {
                    logger.warn("Failed to close build log stream", { app: request.appName, closeErr });
                });
                await rm(logPath, { force: true }).catch((rmErr) => {
                    logger.warn("Failed to remove build log temp file", { app: request.appName, logPath, rmErr });
                });
            }
        }

        throw new BuildError("buildkit build loop exited without returning");
    }

    /**
     * Admission control: waits for a free slot on a specific pool pod when the
     * queue is wired, streaming wait/grant progress into the build log. With
     * no queue, resolves immediately to the shared Service endpoint.
     */
    private async acquireSlot(request: BuildRequest, logStream: BuildLogWriter): Promise<BuildSlot> {
        if (this.queue == null) {
            return { addr: this.warmHost, waitMs: 0, release: async () => {} };
        }
        return await this.queue.acquire({
            appName: request.appName,
            cacheKey: request.cacheKey,
            signal: request.signal,
            onWait: (message) => {
                logStream.write(`\n[previewkit] ${message}\n`);
            },
        });
    }

    private dispatchBuild(
        request: BuildRequest,
        buildkitHost: string,
        logStream: BuildLogWriter,
    ): Promise<BuildDispatchResult> {
        if (request.generatedDockerfile != null) {
            return this.buildWithGeneratedDockerfile(request, request.generatedDockerfile, buildkitHost, logStream);
        }
        const dockerfilePath = this.resolveDockerfile(request.contextPath, request.dockerfile);
        if (dockerfilePath != null) {
            return this.buildWithBuildctl(request, dockerfilePath, buildkitHost, logStream);
        }
        if (request.monorepoTool != null && request.buildContext != null) {
            switch (request.monorepoTool) {
                case "turbo":
                    return this.buildWithTurboMonorepo(request, request.buildContext, buildkitHost, logStream);
                default:
                    throw new Error(`There's no monorepoTool called ${request.monorepoTool}`);
            }
        }
        return this.buildWithRailpack(request, buildkitHost, logStream);
    }

    private async onTransientError(
        err: BuildError,
        attempt: number,
        appName: string,
        logStream: BuildLogWriter,
    ): Promise<void> {
        logger.warn("BuildKit transient error, retrying", {
            app: appName,
            attempt,
            maxRetries: BUILD_MAX_RETRIES,
            message: err.message,
        });
        logStream.write(
            `\n[previewkit] BuildKit transient error - retrying (attempt ${attempt}/${BUILD_MAX_RETRIES})...\n`,
        );
        // Brief delay so a crashed/evicted BuildKit pod has time to restart
        // before the next attempt connects.
        await new Promise<void>((res) => setTimeout(res, BUILDKIT_RETRY_DELAY_MS));
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
        buildkitHost: string,
        logStream: BuildLogWriter,
    ): Promise<BuildDispatchResult> {
        const dockerfileDir = dirname(dockerfilePath);
        const dockerfileName = basename(dockerfilePath);

        logger.info("Building with BuildKit (Dockerfile)", {
            app: request.appName,
            dockerfile: dockerfilePath,
            target: request.target,
            imageTag: request.imageTag,
            buildkitHost,
        });

        const ecrAuth = await this.ecr.getAuth(request.imageTag);
        const dockerConfigDir = ecrAuth != null ? await this.ecr.writeDockerConfig(ecrAuth) : undefined;
        const buildContext = request.buildContext ?? request.contextPath;

        try {
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
                `type=image,name=${request.imageTag},push=true`,
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
            // from our env. Mirrors the railpack/generated-Dockerfile paths.
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
                await rm(dockerConfigDir, { recursive: true }).catch(() => {});
            }
        }
    }

    /**
     * Builds from a Dockerfile generated by `generateDockerfile` (framework-preset
     * builds). The content is written to a tmp dir that becomes buildctl's
     * `dockerfile` local; the app/repo dir is the `context` local. Build args are
     * pre-baked as `ENV` lines by the generator, so they are NOT passed as
     * `--opt build-arg`. Image push + cache plumbing match `buildWithBuildctl`.
     */
    private async buildWithGeneratedDockerfile(
        request: BuildRequest,
        dockerfileContent: string,
        buildkitHost: string,
        logStream: BuildLogWriter,
    ): Promise<BuildDispatchResult> {
        logger.info("Building with generated Dockerfile", {
            app: request.appName,
            imageTag: request.imageTag,
            buildkitHost,
            dockerfileBytes: dockerfileContent.length,
        });

        const ecrAuth = await this.ecr.getAuth(request.imageTag);
        const dockerConfigDir = ecrAuth != null ? await this.ecr.writeDockerConfig(ecrAuth) : undefined;
        const dockerfileDir = join(tmpdir(), `previewkit-generated-dockerfile-${randomUUID()}`);
        await mkdir(dockerfileDir, { recursive: true });

        try {
            await writeFile(join(dockerfileDir, "Dockerfile"), dockerfileContent);

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
                `type=image,name=${request.imageTag},push=true`,
            ];

            const extraEnv: Record<string, string> = {};
            if (dockerConfigDir != null) {
                extraEnv["DOCKER_CONFIG"] = dockerConfigDir;
            }

            await this.exec("buildctl", args, extraEnv, logStream, request.signal);
            return { imageTag: request.imageTag, runtime: "docker-image" };
        } finally {
            await rm(dockerfileDir, { recursive: true }).catch((err) =>
                logger.warn("Failed to clean up generated dockerfile dir", { dockerfileDir, err }),
            );
            if (dockerConfigDir != null) {
                await rm(dockerConfigDir, { recursive: true }).catch((err) =>
                    logger.warn("Failed to clean up docker config dir", { dockerConfigDir, err }),
                );
            }
        }
    }

    private async buildWithRailpack(
        request: BuildRequest,
        buildkitHost: string,
        logStream: BuildLogWriter,
    ): Promise<BuildDispatchResult> {
        logger.info("Building with railpack (auto-detect)", {
            app: request.appName,
            contextPath: request.contextPath,
            imageTag: request.imageTag,
            buildkitHost,
        });

        const ecrAuth = await this.ecr.getAuth(request.imageTag);
        const dockerConfigDir = ecrAuth != null ? await this.ecr.writeDockerConfig(ecrAuth) : undefined;
        const planDir = join(tmpdir(), `previewkit-railpack-plan-${randomUUID()}`);
        await mkdir(planDir, { recursive: true });

        try {
            const envArgs = Object.entries(request.buildArgs).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
            const planPath = join(planDir, "railpack-plan.json");
            await this.exec(
                "railpack",
                ["prepare", request.contextPath, "--plan-out", planPath, ...envArgs],
                {},
                logStream,
                request.signal,
            );
            const runtime = await detectRailpackRuntime(planPath);

            const buildContext = request.buildContext ?? request.contextPath;
            const args = [
                "--addr",
                buildkitHost,
                "build",
                "--progress",
                "plain",
                "--frontend",
                "gateway.v0",
                "--opt",
                "source=ghcr.io/railwayapp/railpack-frontend",
                "--local",
                `context=${buildContext}`,
                "--local",
                `dockerfile=${planDir}`,
                "--opt",
                "platform=linux/amd64",
                "--output",
                `type=image,name=${request.imageTag},push=true`,
            ];

            const buildSecretEnv: Record<string, string> = {};
            for (const [key, value] of Object.entries(request.buildArgs)) {
                args.push("--secret", `id=${key},env=${key}`);
                buildSecretEnv[key] = value;
            }

            const extraEnv: Record<string, string> = { ...buildSecretEnv };
            if (dockerConfigDir != null) {
                extraEnv["DOCKER_CONFIG"] = dockerConfigDir;
            }

            await this.exec("buildctl", args, extraEnv, logStream, request.signal);
            return { imageTag: request.imageTag, runtime };
        } finally {
            await rm(planDir, { recursive: true }).catch(() => {});
            if (dockerConfigDir != null) {
                await rm(dockerConfigDir, { recursive: true }).catch(() => {});
            }
        }
    }

    /**
     * Build path for turbo-based JS/TS monorepos (bun/pnpm/yarn/npm + turbo).
     * Runs railpack from the monorepo root so it picks up the workspace
     * lockfile, then invokes `<pm> run turbo run build --filter=<app>`.
     * Forces `provider: node` to prevent mis-detection on repos that also
     * contain a `Cargo.toml` / `Gemfile` / etc. at the root.
     */
    private async buildWithTurboMonorepo(
        request: BuildRequest,
        buildContext: string,
        buildkitHost: string,
        logStream: BuildLogWriter,
    ): Promise<BuildDispatchResult> {
        const plan = planTurboMonorepoBuild({
            buildContext,
            contextPath: request.contextPath,
            buildArgs: request.buildArgs,
        });

        logger.info("Building turbo monorepo app with railpack", {
            app: request.appName,
            buildContext,
            relAppDir: plan.relAppDir,
            packageManager: plan.pm,
            filterArg: plan.filterArg,
            imageTag: request.imageTag,
            buildkitHost,
        });

        const nonNodeManifests = detectNonNodeRootManifests(buildContext);
        if (nonNodeManifests.length > 0) {
            logger.info("Non-Node manifests detected at monorepo root - forcing railpack provider=node", {
                app: request.appName,
                buildContext,
                manifests: nonNodeManifests,
            });
        }

        const ecrAuth = await this.ecr.getAuth(request.imageTag);
        const dockerConfigDir = ecrAuth != null ? await this.ecr.writeDockerConfig(ecrAuth) : undefined;
        const planDir = join(tmpdir(), `previewkit-monorepo-plan-${Date.now()}`);
        await mkdir(planDir, { recursive: true });
        const cleanupRailpackConfig = await provisionRailpackNodeOverride(buildContext);

        try {
            await this.exec(
                "railpack",
                [
                    "prepare",
                    buildContext,
                    "--build-cmd",
                    plan.buildCmd,
                    "--start-cmd",
                    plan.startCmd,
                    "--plan-out",
                    join(planDir, "railpack-plan.json"),
                ],
                {},
                logStream,
                request.signal,
            );

            const args = [
                "--addr",
                buildkitHost,
                "build",
                "--progress",
                "plain",
                "--frontend",
                "gateway.v0",
                "--opt",
                "source=ghcr.io/railwayapp/railpack-frontend",
                "--local",
                `context=${buildContext}`,
                "--local",
                `dockerfile=${planDir}`,
                "--opt",
                "platform=linux/amd64",
                "--output",
                `type=image,name=${request.imageTag},push=true`,
            ];

            const buildSecretEnv: Record<string, string> = {};
            for (const [key, value] of Object.entries(request.buildArgs)) {
                args.push("--secret", `id=${key},env=${key}`);
                buildSecretEnv[key] = value;
            }

            const extraEnv: Record<string, string> = { ...buildSecretEnv };
            if (dockerConfigDir != null) {
                extraEnv["DOCKER_CONFIG"] = dockerConfigDir;
            }

            await this.exec("buildctl", args, extraEnv, logStream, request.signal);
            return { imageTag: request.imageTag, runtime: "node" };
        } finally {
            await rm(planDir, { recursive: true }).catch((err) => {
                logger.warn("Failed to clean up railpack plan dir", { planDir, err });
            });
            await cleanupRailpackConfig();
            if (dockerConfigDir != null) {
                await rm(dockerConfigDir, { recursive: true }).catch((err) => {
                    logger.warn("Failed to clean up docker config dir", { dockerConfigDir, err });
                });
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
                            ...(isTransient ? { userFacingMessage: BUILD_INFRA_UNAVAILABLE_MESSAGE } : {}),
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

async function detectRailpackRuntime(planPath: string): Promise<BuildRuntime> {
    try {
        const raw = await readFile(planPath, "utf8");
        const plan: unknown = JSON.parse(raw);
        if (containsNodeRuntimeSignal(plan)) return "node";
        return "unknown";
    } catch (err) {
        logger.warn("Failed to detect Railpack runtime", { planPath, err });
        return "unknown";
    }
}

function containsNodeRuntimeSignal(value: unknown): boolean {
    if (typeof value === "string") return value.toLowerCase() === "node";
    if (Array.isArray(value)) return value.some((entry) => containsNodeRuntimeSignal(entry));
    if (value == null || typeof value !== "object") return false;

    return Object.entries(value).some(([key, nested]) => {
        const normalizedKey = key.toLowerCase();
        const isRuntimeField =
            normalizedKey === "provider" || normalizedKey === "runtime" || normalizedKey === "language";
        if (isRuntimeField && typeof nested === "string" && nested.toLowerCase() === "node") return true;
        return containsNodeRuntimeSignal(nested);
    });
}
