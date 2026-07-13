import { previewkitRuntimeImage } from "@autonoma/types";
import type { Build } from "../config/schema";
import { mirrorDockerHubImage } from "../deployer/image-mirror";
import { nodeBuildCommands } from "./node-package-manager";
import type { GenerateDockerfileContext, RawSpec } from "./raw-spec";

/** A framework preset (node / next / vite / bun) - excludes the user-Dockerfile and raw-runtime arms. */
type FrameworkBuild = Exclude<Build, { framework: "dockerfile" | "runtime" }>;

/** Bun ships its own image; the node frameworks resolve their base image through the shared runtime catalog. */
const BUN_IMAGE = "oven/bun:1";

/**
 * Lowers a framework preset into the raw primitive: the node base image (from the
 * one runtime catalog, so node is not defined twice) or the bun image, then the
 * package-manager-resolved install / build / run commands. Keeps the current
 * framework layout (`/app`, no toolbelt) - this is a code consolidation, not a
 * behavior change.
 */
export function lowerFrameworkBuild(build: FrameworkBuild, ctx: GenerateDockerfileContext): RawSpec {
    const commands = nodeBuildCommands(build, ctx.turboFilter);
    return {
        baseImage: mirrorDockerHubImage(frameworkImage(build), ctx.registryMirror),
        workdir: "/app",
        bootstrap: commands.bootstrap != null ? [`RUN ${commands.bootstrap}`] : [],
        install: [`RUN ${commands.install}`],
        build: [`RUN ${commands.build}`],
        start: commands.run,
    };
}

function frameworkImage(build: FrameworkBuild): string {
    if (build.framework === "bun") return BUN_IMAGE;
    return previewkitRuntimeImage("node", build.node_version);
}
