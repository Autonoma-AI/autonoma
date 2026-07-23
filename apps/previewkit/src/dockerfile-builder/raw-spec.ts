import { npmRegistryEnvLines } from "./npm-registry-env";
import { quoteEnv } from "./quote-env";

/**
 * The raw primitive every generated Dockerfile renders from, and the single
 * renderer for it. A framework preset and the raw runtime escape hatch both lower
 * to a {@link RawSpec}; this file is the only place that knows the Dockerfile
 * layout, so neither lowering repeats it.
 *
 * Command groups map to fixed positions so build args land where they should:
 * `bootstrap` (cached, pre-`COPY`), then `COPY . .`, then `install` (before the
 * build-arg `ENV` lines, so dependency installs stay cache-stable across secret
 * changes), then the `ENV` lines, then `build` (which can read the build args).
 * The npm registry mirror lines land earlier, right after `WORKDIR`, since
 * `install` is exactly the step they need to affect.
 */

export interface RawSpec {
    /** Base image, already rewritten through the registry mirror. */
    baseImage: string;
    /** In-image working directory (`COPY . .` target). */
    workdir: string;
    /** `RUN` lines before `COPY` - stable cache layers (corepack, toolbelt install). */
    bootstrap: string[];
    /** `RUN` lines after `COPY`, before the build-arg `ENV` lines. */
    install: string[];
    /** `RUN` lines after the build-arg `ENV` lines. */
    build: string[];
    /** The `CMD` payload (shell form), without the `CMD` prefix. */
    start: string;
}

export interface GenerateDockerfileContext {
    /** ECR pull-through cache prefix for Docker Hub base images; "" disables mirroring. */
    registryMirror: string;
    /**
     * npm/bun package-registry cache URL (e.g. the in-cluster Verdaccio
     * Service); emitted as `npm_config_registry`/`BUN_CONFIG_REGISTRY` `ENV`
     * lines right after `WORKDIR`. "" disables injection.
     */
    npmRegistryMirror: string;
    /** Merged build args (build_args + resolved build_secrets); emitted as `ENV` lines. */
    buildArgs: Record<string, string>;
    /** Container port the app listens on; emitted as `ENV PORT` + `EXPOSE`. */
    port: number;
    /** App name (Kubernetes name); used as the raw runtime WORKDIR. */
    appName: string;
    /**
     * Resolved turbo `--filter=<spec>` argument (by workspace package name, with a
     * path-based fallback) for root-context node-family builds. Undefined for
     * app-context and runtime builds, which never filter.
     */
    turboFilter?: string;
}

/** Renders a {@link RawSpec} into a single-stage Dockerfile string. */
export function renderDockerfile(spec: RawSpec, ctx: GenerateDockerfileContext): string {
    const lines: string[] = [
        "# syntax=docker/dockerfile:1.7",
        "",
        `FROM ${spec.baseImage}`,
        `WORKDIR ${spec.workdir}`,
        "",
    ];

    if (ctx.npmRegistryMirror !== "") {
        lines.push(...npmRegistryEnvLines(ctx.npmRegistryMirror), "");
    }

    for (const line of spec.bootstrap) {
        lines.push(line, "");
    }

    lines.push("COPY . .", "");

    for (const line of spec.install) {
        lines.push(line, "");
    }

    for (const line of envLines(ctx.buildArgs)) {
        lines.push(line);
    }
    lines.push(`ENV PORT=${ctx.port}`, "");

    for (const line of spec.build) {
        lines.push(line, "");
    }

    lines.push(`EXPOSE ${ctx.port}`);
    lines.push(`CMD ${spec.start}`);

    return lines.join("\n") + "\n";
}

function envLines(buildArgs: Record<string, string>): string[] {
    return Object.entries(buildArgs).map(([key, value]) => `ENV ${key}=${quoteEnv(value)}`);
}
