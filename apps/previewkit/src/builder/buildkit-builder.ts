import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { logger } from "../logger";
import type { Builder, BuildRequest, BuildResult } from "./builder";

const execFileAsync = promisify(execFile);

const BUILD_TIMEOUT = 600_000; // 10 minutes

interface BuildKitBuilderOptions {
    buildkitHost: string;
}

/**
 * Builds container images using two strategies:
 *
 * 1. If the app has a Dockerfile → build it with `buildctl` (BuildKit CLI)
 * 2. If no Dockerfile exists → build with `railpack` which auto-detects
 *    the language/framework and builds directly via BuildKit LLB
 *
 * Both paths require a BuildKit daemon running at the configured host.
 * No Docker daemon is needed.
 */
export class BuildKitBuilder implements Builder {
    private buildkitHost: string;

    constructor(options: BuildKitBuilderOptions) {
        this.buildkitHost = options.buildkitHost;
    }

    async build(request: BuildRequest): Promise<BuildResult> {
        const start = Date.now();

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
            const resolved = path.resolve(contextPath, dockerfile);
            if (!existsSync(resolved)) {
                throw new Error(`Specified Dockerfile not found: ${dockerfile} (resolved to ${resolved})`);
            }
            return resolved;
        }

        const defaultPath = path.join(contextPath, "Dockerfile");
        if (existsSync(defaultPath)) {
            return defaultPath;
        }

        return undefined;
    }

    /**
     * Build a Dockerfile with buildctl.
     */
    private async buildWithBuildctl(request: BuildRequest, dockerfilePath: string): Promise<string> {
        const dockerfileDir = path.dirname(dockerfilePath);
        const dockerfileName = path.basename(dockerfilePath);

        logger.info("Building with BuildKit (Dockerfile)", {
            app: request.appName,
            dockerfile: dockerfilePath,
            imageTag: request.imageTag,
        });

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
            "--output",
            `type=image,name=${request.imageTag},push=true`,
        ];

        for (const [key, value] of Object.entries(request.buildArgs)) {
            args.push("--opt", `build-arg:${key}=${value}`);
        }

        await this.exec("buildctl", args);
        return request.imageTag;
    }

    /**
     * Build with Railpack — auto-detects language/framework and builds
     * directly via BuildKit LLB. No Dockerfile needed.
     */
    private async buildWithRailpack(request: BuildRequest): Promise<string> {
        logger.info("Building with Railpack (auto-detect)", {
            app: request.appName,
            contextPath: request.contextPath,
            imageTag: request.imageTag,
        });

        const args = ["build", request.contextPath, "--name", request.imageTag];

        for (const [key, value] of Object.entries(request.buildArgs)) {
            args.push("--env", `${key}=${value}`);
        }

        await this.exec("railpack", args, {
            BUILDKIT_HOST: this.buildkitHost,
        });

        return request.imageTag;
    }

    private async exec(command: string, args: string[], extraEnv?: Record<string, string>): Promise<void> {
        try {
            const { stdout, stderr } = await execFileAsync(command, args, {
                timeout: BUILD_TIMEOUT,
                env: { ...process.env, ...extraEnv },
            });

            if (stdout) logger.debug(`${command} stdout`, { stdout });
            if (stderr) logger.debug(`${command} stderr`, { stderr });
        } catch (err: unknown) {
            if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
                throw new Error(`${command} binary not found`);
            }
            throw new Error(`Build failed for ${command}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}
