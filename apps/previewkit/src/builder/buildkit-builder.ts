import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { logger } from "../logger";
import type { Builder, BuildRequest, BuildResult } from "./builder";
import { EcrRegistryClient } from "./ecr-client";

const BUILD_TIMEOUT = 600_000; // 10 minutes

interface BuildKitBuilderOptions {
    buildkitHost: string;
}

/**
 * Builds container images using two strategies:
 *
 * 1. If the app has a Dockerfile - build with `buildctl` and `dockerfile.v0`
 * 2. If no Dockerfile exists - run `railpack prepare` to generate a build plan,
 *    then build with `buildctl` using the railpack BuildKit frontend.
 *
 * Both paths push directly to the registry via buildctl's image exporter.
 */
export class BuildKitBuilder implements Builder {
    private buildkitHost: string;
    private ecr: EcrRegistryClient;

    constructor(options: BuildKitBuilderOptions) {
        this.buildkitHost = options.buildkitHost;
        this.ecr = new EcrRegistryClient();
    }

    async build(request: BuildRequest): Promise<BuildResult> {
        const start = Date.now();

        await this.ecr.ensureRepo(request.imageTag);

        const hasDockerfile = this.resolveDockerfile(request.contextPath, request.dockerfile);

        let imageTag: string;
        if (hasDockerfile) {
            imageTag = await this.buildWithBuildctl(request, hasDockerfile);
        } else {
            imageTag = await this.buildWithRailpack(request);
        }

        const durationMs = Date.now() - start;

        logger.info("Build complete", { app: request.appName, imageTag, durationMs });

        return { imageTag, durationMs };
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

    /**
     * Build a Dockerfile with buildctl.
     */
    private async buildWithBuildctl(request: BuildRequest, dockerfilePath: string): Promise<string> {
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
            ];

            for (const [key, value] of Object.entries(request.buildArgs)) {
                args.push("--opt", `build-arg:${key}=${value}`);
            }

            const extraEnv: Record<string, string> = {};
            if (dockerConfigDir != null) {
                extraEnv["DOCKER_CONFIG"] = dockerConfigDir;
            }

            await this.exec("buildctl", args, extraEnv);
            return request.imageTag;
        } finally {
            if (dockerConfigDir != null) {
                await rm(dockerConfigDir, { recursive: true }).catch((_e) => {});
            }
        }
    }

    /**
     * Build with railpack, which auto-detects the language/framework.
     *
     * Two steps:
     * 1. `railpack prepare` generates a railpack-plan.json describing the build.
     * 2. `buildctl build` uses the railpack BuildKit frontend to execute the plan
     *    and push the image directly to the registry - no Docker daemon required.
     */
    private async buildWithRailpack(request: BuildRequest): Promise<string> {
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
            await this.exec("railpack", [
                "prepare",
                request.contextPath,
                "--plan-out",
                join(planDir, "railpack-plan.json"),
            ]);

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
            ];

            for (const [key, value] of Object.entries(request.buildArgs)) {
                args.push("--opt", `build-arg:${key}=${value}`);
            }

            const extraEnv: Record<string, string> = {};
            if (dockerConfigDir != null) {
                extraEnv["DOCKER_CONFIG"] = dockerConfigDir;
            }

            await this.exec("buildctl", args, extraEnv);
            return request.imageTag;
        } finally {
            await rm(planDir, { recursive: true }).catch((_e) => {});
            if (dockerConfigDir != null) {
                await rm(dockerConfigDir, { recursive: true }).catch((_e) => {});
            }
        }
    }

    private exec(command: string, args: string[], extraEnv?: Record<string, string>): Promise<void> {
        return new Promise((resolve, reject) => {
            const child = spawn(command, args, {
                env: { ...process.env, ...extraEnv },
                timeout: BUILD_TIMEOUT,
            });

            child.on("error", (err: NodeJS.ErrnoException) => {
                reject(err.code === "ENOENT" ? new Error(`${command} binary not found`) : err);
            });

            const outputLines: string[] = [];

            for (const stream of [child.stdout, child.stderr]) {
                createInterface({ input: stream }).on("line", (line) => {
                    logger.info(`[build] ${line}`, { command });
                    outputLines.push(line);
                });
            }

            child.on("close", (code) => {
                if (child.killed) {
                    reject(new Error(`Build timed out after ${BUILD_TIMEOUT / 1000}s`));
                } else if (code === 0) {
                    resolve();
                } else {
                    const output = outputLines.join("\n");
                    reject(new Error(`Build failed for ${command}:\n${output || `exit code ${code}`}`));
                }
            });
        });
    }
}
