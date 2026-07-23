import type { Build } from "../config/schema";
import { logger as rootLogger } from "../logger";
import { lowerFrameworkBuild } from "./framework-lowering";
import { renderDockerfile, type GenerateDockerfileContext } from "./raw-spec";
import { lowerRuntimeBuild } from "./runtime-lowering";

export type { GenerateDockerfileContext } from "./raw-spec";

/** Build shapes that produce a generated Dockerfile - everything except the user-Dockerfile case. */
type GeneratedBuild = Exclude<Build, { framework: "dockerfile" }>;

/**
 * Generates a single-stage Dockerfile for a generated build. Both a framework
 * preset (node / next / vite / bun) and the raw runtime escape hatch lower to a
 * `RawSpec` and render through the one `renderDockerfile`; this entry just picks
 * the lowering and logs. The user-Dockerfile case never reaches here (the builder
 * dispatches it separately).
 *
 * Intentionally NOT multi-stage yet - slim, static-optimized images are a later
 * optimization.
 */
export function generateDockerfile(build: GeneratedBuild, ctx: GenerateDockerfileContext): string {
    const logger = rootLogger.child({ name: "generateDockerfile" });
    const runtime = build.framework === "runtime" ? build.runtime : undefined;
    const runtimeVersion = build.framework === "runtime" ? build.version : undefined;
    logger.info("Generating Dockerfile", {
        framework: build.framework,
        runtime,
        runtimeVersion,
        buildContext: build.build_context,
        mirrorActive: ctx.registryMirror !== "",
        npmMirrorActive: ctx.npmRegistryMirror !== "",
        buildArgCount: Object.keys(ctx.buildArgs).length,
    });

    const spec = build.framework === "runtime" ? lowerRuntimeBuild(build, ctx) : lowerFrameworkBuild(build, ctx);
    const dockerfile = renderDockerfile(spec, ctx);

    logger.info("Dockerfile generated", { framework: build.framework, runtime, runtimeVersion });
    return dockerfile;
}
