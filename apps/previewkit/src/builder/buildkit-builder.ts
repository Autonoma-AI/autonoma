import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, type WriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { S3Storage } from "@autonoma/storage";
import { logger } from "../logger";
import type { Builder, BuildRequest, BuildResult } from "./builder";
import { EcrRegistryClient } from "./ecr-client";

const BUILD_TIMEOUT = 600_000; // 10 minutes
const LOG_KEY_PREFIX = "buildctl/logs";

interface BuildKitBuilderOptions {
    buildkitHost: string;
    storage: S3Storage;
}

/**
 * Builds container images using two strategies:
 *
 * 1. If the app has a Dockerfile - build with `buildctl` and `dockerfile.v0`
 * 2. If no Dockerfile exists - run `railpack prepare` to generate a build plan,
 *    then build with `buildctl` using the railpack BuildKit frontend.
 *
 * Both paths push directly to the registry via buildctl's image exporter.
 *
 * Per-build stdout+stderr is captured to a temp file and uploaded to object
 * storage. The `logUrl` is returned in the BuildResult so callers can link to
 * the captured logs.
 */
export class BuildKitBuilder implements Builder {
    private readonly buildkitHost: string;
    private ecr: EcrRegistryClient;
    private readonly storage: S3Storage;

    constructor(options: BuildKitBuilderOptions) {
        this.buildkitHost = options.buildkitHost;
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
        const common = `type=s3,region=${this.storage.region},bucket=${this.storage.bucket},name=${cacheKey}`;
        return ["--import-cache", common, "--export-cache", `${common},mode=max`];
    }

    async build(request: BuildRequest): Promise<BuildResult> {
        const start = Date.now();
        await this.ecr.ensureRepo(request.imageTag);

        const logPath = this.buildLogPath(request.imageTag);
        const logStream = createWriteStream(logPath, { flags: "a" });

        try {
            const hasDockerfile = this.resolveDockerfile(request.contextPath, request.dockerfile);

            let imageTag: string;
            try {
                if (hasDockerfile) {
                    imageTag = await this.buildWithBuildctl(request, hasDockerfile, logStream);
                } else {
                    imageTag = await this.buildWithRailpack(request, logStream);
                }
            } catch (buildErr) {
                // Even on failure we still want the logs uploaded so the
                // operator can investigate. If the upload itself also fails,
                // surface that as a note on the original build error rather
                // than masking the build failure with an upload failure.
                try {
                    const logUrl = await this.closeAndUploadLog(logStream, logPath, request.imageTag);
                    if (buildErr instanceof Error) {
                        buildErr.message = `${buildErr.message}\nBuild logs: ${logUrl}`;
                    }
                } catch (uploadErr) {
                    logger.error("Build failed AND log upload failed", uploadErr, { imageTag: request.imageTag });
                    if (buildErr instanceof Error) {
                        const uploadMessage = uploadErr instanceof Error ? uploadErr.message : String(uploadErr);
                        buildErr.message = `${buildErr.message}\nBuild log upload failed: ${uploadMessage}`;
                    }
                }
                throw buildErr;
            }

            // Successful build: upload is fatal. A built image with no logs is
            // worse than a noisy failure — we want to know now, not later.
            const logUrl = await this.closeAndUploadLog(logStream, logPath, request.imageTag);
            const durationMs = Date.now() - start;
            logger.info("Build complete", { app: request.appName, imageTag, durationMs, logUrl });

            return { imageTag, durationMs, logUrl };
        } finally {
            await rm(logPath, { force: true }).catch(() => {});
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
        logStream: WriteStream,
    ): Promise<string> {
        const dockerfileDir = dirname(dockerfilePath);
        const dockerfileName = basename(dockerfilePath);

        logger.info("Building with BuildKit (Dockerfile)", {
            app: request.appName,
            dockerfile: dockerfilePath,
            imageTag: request.imageTag,
        });

        const ecrAuth = await this.ecr.getAuth(request.imageTag);
        const dockerConfigDir = ecrAuth != null ? await this.ecr.writeDockerConfig(ecrAuth) : undefined;

        try {
            const args = [
                "--addr",
                this.buildkitHost,
                "build",
                "--frontend",
                "dockerfile.v0",
                "--local",
                `context=${request.contextPath}`,
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
            return request.imageTag;
        } finally {
            if (dockerConfigDir != null) {
                await rm(dockerConfigDir, { recursive: true }).catch(() => {});
            }
        }
    }

    private async buildWithRailpack(request: BuildRequest, logStream: WriteStream): Promise<string> {
        logger.info("Building with railpack (auto-detect)", {
            app: request.appName,
            contextPath: request.contextPath,
            imageTag: request.imageTag,
        });

        const ecrAuth = await this.ecr.getAuth(request.imageTag);
        const dockerConfigDir = ecrAuth != null ? await this.ecr.writeDockerConfig(ecrAuth) : undefined;
        const planDir = join(tmpdir(), `previewkit-railpack-plan-${Date.now()}`);
        await mkdir(planDir, { recursive: true });

        try {
            await this.exec(
                "railpack",
                ["prepare", request.contextPath, "--plan-out", join(planDir, "railpack-plan.json")],
                {},
                logStream,
            );

            const args = [
                "--addr",
                this.buildkitHost,
                "build",
                "--frontend",
                "gateway.v0",
                "--opt",
                "source=ghcr.io/railwayapp/railpack-frontend",
                "--local",
                `context=${request.contextPath}`,
                "--local",
                `dockerfile=${planDir}`,
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
            return request.imageTag;
        } finally {
            await rm(planDir, { recursive: true }).catch(() => {});
            if (dockerConfigDir != null) {
                await rm(dockerConfigDir, { recursive: true }).catch(() => {});
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
                timeout: BUILD_TIMEOUT,
            });

            child.on("error", (err: NodeJS.ErrnoException) => {
                reject(err.code === "ENOENT" ? new Error(`${command} binary not found`) : err);
            });

            // Pipe both streams to the log file; do NOT end the destination when
            // a source ends, since multiple exec() calls share the same stream.
            child.stdout.pipe(logStream, { end: false });
            child.stderr.pipe(logStream, { end: false });

            child.on("close", (code) => {
                if (child.killed) {
                    reject(new Error(`${command} timed out after ${BUILD_TIMEOUT / 1000}s`));
                } else if (code === 0) {
                    resolvePromise();
                } else {
                    reject(new Error(`${command} exited with code ${code}`));
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
