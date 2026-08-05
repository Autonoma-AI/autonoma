import { PREVIEWKIT_BUILD_SCRIPT_HEREDOC, PREVIEWKIT_RUNTIME_CATALOG, previewkitRuntimeImage } from "@autonoma/types";
import type { Build } from "../config/schema";
import { mirrorDockerHubImage } from "../deployer/image-mirror";
import { toolbeltInstall } from "./os-toolbelt";
import type { GenerateDockerfileContext, RawSpec } from "./raw-spec";

/** The raw runtime escape hatch arm of the build union. */
type RuntimeBuild = Extract<Build, { framework: "runtime" }>;

/**
 * Switch the shell for RUN/CMD to bash. Every runtime is a Debian-family image
 * that ships `/bin/bash` natively, so the user's bash `build_script` and
 * `entrypoint` run under the shell they were written for (arrays, `[[ ]]`,
 * `set -o pipefail`) rather than the default `/bin/sh` (dash). Placed after the
 * toolbelt to keep the layout uniform with the rest of the bootstrap.
 */
const SHELL_BASH = `SHELL ["/bin/bash", "-c"]`;

/**
 * Lowers the raw runtime escape hatch into the raw primitive: the picked runtime's
 * base image (from the catalog, at the user-selected version), a base-tiered
 * toolbelt + per-runtime setup as cached layers, then the user's bash build script
 * (as a heredoc so multi-line survives) and entrypoint. App-context builds copy the
 * app to `/workspace/<app>` to match the sandbox reference; a root (monorepo)
 * blueprint build copies the whole repo to `/workspace` - its build script
 * cd-scopes itself - and WORKDIRs into the app before CMD, so the container (and
 * any deploy-time command override) starts in the app's own directory. Only the
 * blueprint pipeline passes `ctx.appPath`; the hand-authored build model renders
 * exactly as before without it.
 */
export function lowerRuntimeBuild(build: RuntimeBuild, ctx: GenerateDockerfileContext): RawSpec {
    const spec = PREVIEWKIT_RUNTIME_CATALOG[build.runtime];
    const image = previewkitRuntimeImage(build.runtime, build.version);
    const rootAppPath = build.build_context === "root" ? ctx.appPath : undefined;
    return {
        baseImage: mirrorDockerHubImage(image, ctx.registryMirror),
        workdir: rootAppPath != null ? "/workspace" : `/workspace/${ctx.appName}`,
        appWorkdir: rootAppPath != null && rootAppPath !== "." ? `/workspace/${rootAppPath}` : undefined,
        bootstrap: [toolbeltInstall(spec.base), ...spec.setup.map((command) => `RUN ${command}`), SHELL_BASH],
        install: [],
        build: build.build_script != null ? [heredocRun(build.build_script)] : [],
        start: build.entrypoint,
    };
}

/**
 * Wraps a (possibly multi-line) bash build script in a Dockerfile 1.7 heredoc so
 * it runs verbatim under the active shell (bash, per the `SHELL` directive above) -
 * preserving loops, conditionals, and multiple statements that a single-line `RUN`
 * would break. The delimiter is quoted so the Dockerfile parser leaves `$VAR`
 * alone; the shell still expands it from the build-arg `ENV` at run time. The
 * schema rejects a script whose line equals the delimiter, so it cannot close the
 * heredoc early.
 */
function heredocRun(script: string): string {
    return `RUN <<'${PREVIEWKIT_BUILD_SCRIPT_HEREDOC}'\n${script}\n${PREVIEWKIT_BUILD_SCRIPT_HEREDOC}`;
}
