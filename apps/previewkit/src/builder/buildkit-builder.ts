import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, type WriteStream } from "node:fs";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { S3Storage } from "@autonoma/storage";
import { logger } from "../logger";
import { BuildError, type Builder, type BuildRequest, type BuildResult, type BuildRuntime } from "./builder";
import type { BuildKitInstance, BuildKitJobManager } from "./buildkit-job-manager";
import { EcrRegistryClient } from "./ecr-client";
import { detectNonNodeRootManifests, planTurboMonorepoBuild, provisionRailpackNodeOverride } from "./turbo-monorepo";

const LOG_KEY_PREFIX = "buildctl/logs";
const BUILD_MAX_RETRIES = 3;
const BUILDKIT_RETRY_DELAY_MS = 5000;
// Keep only the tail of each stream for transient error detection.
// 8 KB is enough for any error string without buffering the full build log.
const TAIL_SIZE = 8192;

/**
 * Substrings that, when found in buildctl's stdout/stderr tail, indicate the
 * remote buildkitd disappeared mid-build rather than the build itself
 * failing. Most of these surface when the buildkitd pod is evicted by
 * kubelet (node pressure, spot interruption), OOMKilled, or otherwise
 * terminated by the cluster - all cases where retrying on a fresh Job is
 * the right move. False positives here just burn one retry attempt, so we
 * lean inclusive.
 */
const TRANSIENT_NETWORK_PATTERNS: readonly RegExp[] = [
    /graceful_stop/,
    /connection refused/,
    /connection reset/,
    /broken pipe/,
    /unexpected EOF/,
    /rpc error.*code = Unavailable/,
    /transport.*error while dialing/,
    /transport is closing/,
    /no such host/,
];

interface BuildKitBuilderOptions {
    /** Per-build buildkitd lifecycle. The builder calls
     *  `jobManager.provision()` at the start of each build, uses the returned
     *  `host` as buildctl's `--addr`, and calls `release()` in `finally`. */
    jobManager: BuildKitJobManager;
    buildTimeoutMs: number;
    storage: S3Storage;
}

interface BuildDispatchResult {
    imageTag: string;
    runtime: BuildRuntime;
}

/**
 * Builds container images using two strategies:
 *
 * 1. If the app has a Dockerfile - build with `buildctl` and `dockerfile.v0`
 * 2. Otherwise - run `railpack prepare` from the app directory.
 *
 * All paths push directly to the registry via buildctl's image exporter.
 *
 * Per-build stdout+stderr is captured to a temp file and uploaded to object
 * storage. The `logUrl` is returned in the BuildResult so callers can link to
 * the captured logs.
 */
export class BuildKitBuilder implements Builder {
    private readonly jobManager: BuildKitJobManager;
    private readonly buildTimeoutMs: number;
    private ecr: EcrRegistryClient;
    private readonly storage: S3Storage;

    constructor(options: BuildKitBuilderOptions) {
        this.jobManager = options.jobManager;
        this.buildTimeoutMs = options.buildTimeoutMs;
        this.ecr = new EcrRegistryClient();
        this.storage = options.storage;
    }

    /**
     * Returns the `--import-cache` + `--export-cache` argv pairs for this
     * request, or an empty array when no cacheKey was supplied. Bucket +
     * region are read off the shared S3Storage; `mode=max` exports all
     * intermediate layers (not just the final image's), which is what we want
     * for fast subsequent builds of the same app.
     */
    private buildCacheArgs(cacheKey: string): string[] {
        const common = `type=s3,region=${this.storage.region},bucket=${this.storage.bucket},name=${cacheKey},blobs_prefix=buildctl/blobs/,manifests_prefix=buildctl/manifests/`;
        return ["--import-cache", common, "--export-cache", `${common},mode=max`];
    }

    async build(request: BuildRequest): Promise<BuildResult> {
        const start = Date.now();
        await this.ecr.ensureRepo(request.imageTag);

        for (let attempt = 1; attempt <= BUILD_MAX_RETRIES; attempt++) {
            const isLastAttempt = attempt === BUILD_MAX_RETRIES;
            const logPath = this.buildLogPath(request.imageTag);
            const logStream = createWriteStream(logPath, { flags: "a" });
            // Fresh buildkitd per attempt: a transient failure usually means the
            // previous buildkit Job's pod is in a bad state (evicted, gracefully
            // stopped, etc.), so retrying against the same pod is pointless.
            let instance: BuildKitInstance | undefined;

            try {
                instance = await this.jobManager.provision();
                const build = await this.dispatchBuild(request, instance.host, logStream);
                const logUrl = await this.closeAndUploadLog(logStream, logPath, request.imageTag);
                const durationMs = Date.now() - start;
                logger.info("Build complete", {
                    app: request.appName,
                    imageTag: build.imageTag,
                    runtime: build.runtime,
                    durationMs,
                    logUrl,
                });
                return { imageTag: build.imageTag, durationMs, logUrl, runtime: build.runtime };
            } catch (err) {
                if (err instanceof BuildError && err.isTransient && !isLastAttempt) {
                    await this.onTransientError(err, attempt, request.appName, logStream, logPath, request.imageTag);
                    continue;
                }
                if (err instanceof BuildError) {
                    throw await this.annotateWithLogs(err, logStream, logPath, request.imageTag);
                }
                throw err;
            } finally {
                const toRelease = instance;
                if (toRelease != null) {
                    await this.jobManager.release(toRelease).catch((releaseErr) => {
                        logger.fatal("Failed to release buildkit Job", {
                            app: request.appName,
                            name: toRelease.name,
                            releaseErr,
                        });
                    });
                }
                await rm(logPath, { force: true }).catch(() => {});
            }
        }

        throw new BuildError("buildkit build loop exited without returning");
    }

    private dispatchBuild(
        request: BuildRequest,
        buildkitHost: string,
        logStream: WriteStream,
    ): Promise<BuildDispatchResult> {
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
        logStream: WriteStream,
        logPath: string,
        imageTag: string,
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
        try {
            await this.closeAndUploadLog(logStream, logPath, imageTag);
        } catch {
            // best-effort upload of partial logs on transient failure
        }
        // Brief delay so a crashed/evicted BuildKit pod has time to restart
        // before the next attempt connects.
        await new Promise<void>((res) => setTimeout(res, BUILDKIT_RETRY_DELAY_MS));
    }

    private async annotateWithLogs(
        err: BuildError,
        logStream: WriteStream,
        logPath: string,
        imageTag: string,
    ): Promise<never> {
        let logUrl: string | undefined;
        try {
            logUrl = await this.closeAndUploadLog(logStream, logPath, imageTag);
        } catch (uploadErr) {
            logger.error("Build failed AND log upload failed", uploadErr, { imageTag });
        }
        throw new BuildError(err.message, { logUrl, cause: err });
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
        logStream: WriteStream,
    ): Promise<BuildDispatchResult> {
        const dockerfileDir = dirname(dockerfilePath);
        const dockerfileName = basename(dockerfilePath);

        logger.info("Building with BuildKit (Dockerfile)", {
            app: request.appName,
            dockerfile: dockerfilePath,
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
                ...this.buildCacheArgs(request.cacheKey),
            ];

            for (const [key, value] of Object.entries(request.buildArgs)) {
                args.push("--opt", `build-arg:${key}=${value}`);
            }

            const extraEnv: Record<string, string> = {};
            if (dockerConfigDir != null) {
                extraEnv["DOCKER_CONFIG"] = dockerConfigDir;
            }

            await this.exec("buildctl", args, extraEnv, logStream);
            return { imageTag: request.imageTag, runtime: "docker-image" };
        } finally {
            if (dockerConfigDir != null) {
                await rm(dockerConfigDir, { recursive: true }).catch(() => {});
            }
        }
    }

    private async buildWithRailpack(
        request: BuildRequest,
        buildkitHost: string,
        logStream: WriteStream,
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
                ...this.buildCacheArgs(request.cacheKey),
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

            await this.exec("buildctl", args, extraEnv, logStream);
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
        logStream: WriteStream,
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
                ...this.buildCacheArgs(request.cacheKey),
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

            await this.exec("buildctl", args, extraEnv, logStream);
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
        logStream: WriteStream,
    ): Promise<void> {
        return new Promise((resolvePromise, reject) => {
            logStream.write(`\n$ ${command} ${args.join(" ")}\n`);

            const child = spawn(command, args, {
                env: { ...process.env, ...extraEnv },
                timeout: this.buildTimeoutMs,
            });

            child.on("error", (err: NodeJS.ErrnoException) => {
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
                if (child.killed) {
                    reject(new BuildError(`${command} timed out after ${this.buildTimeoutMs / 1000}s`));
                } else if (code === 0) {
                    resolvePromise();
                } else {
                    const combined = stdoutTail + stderrTail;
                    const isTransient = TRANSIENT_NETWORK_PATTERNS.some((p) => p.test(combined));
                    reject(new BuildError(`${command} exited with code ${code}`, { isTransient }));
                }
            });
        });
    }

    /**
     * Closes the log stream and uploads the file to object storage. Throws on
     * any failure (upload, empty file, stat) — callers are expected to either
     * propagate or annotate the original build error.
     */
    private async closeAndUploadLog(logStream: WriteStream, logPath: string, imageTag: string): Promise<string> {
        await new Promise<void>((res) => logStream.end(res));

        const { size } = await stat(logPath);
        if (size === 0) {
            throw new Error(`Build log file is empty at ${logPath} — nothing to upload`);
        }

        const key = this.buildLogKey(imageTag);
        const readStream = createReadStream(logPath);
        const url = await this.storage.uploadStream(
            key,
            // Node's fs.ReadStream is a Readable; the storage API accepts a
            // web ReadableStream. Use the toWeb helper.
            (await import("node:stream")).Readable.toWeb(readStream) as ReadableStream,
            "text/plain",
        );
        logger.info("Build logs uploaded", { url, bytes: size });
        return url;
    }

    private buildLogPath(imageTag: string): string {
        const safe = imageTag.replace(/[^A-Za-z0-9_.-]/g, "_");
        return join(tmpdir(), `previewkit-build-log-${safe}-${Date.now()}.log`);
    }

    /**
     * Derive a deterministic-but-unique S3 key from an imageTag like
     *   `acct.dkr.ecr.us-east-1.amazonaws.com/preview-acme-bank/api:pr-42-abc1234`
     * The registry prefix is stripped and `:` becomes `/`, giving:
     *   `previewkit-build-logs/preview-acme-bank/api/pr-42-abc1234-<epoch>.log`
     */
    private buildLogKey(imageTag: string): string {
        const slashIdx = imageTag.indexOf("/");
        const withoutRegistry = slashIdx >= 0 ? imageTag.slice(slashIdx + 1) : imageTag;
        const path = withoutRegistry.replace(":", "/");
        return `${LOG_KEY_PREFIX}/${path}-${Date.now()}.log`;
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
