/**
 * What the retired node-family build presets (node / next / vite / bun) actually
 * run: the install / build / start commands each preset resolves to, driven by
 * the shared package-manager strategy table in `previewkit-node-pm.ts`.
 *
 * It sits beside the schema rather than in previewkit because two places need
 * the same answer - previewkit's Dockerfile generator lowering a stored preset,
 * and `toAuthorableDocument` writing that preset out as an equivalent `runtime`
 * build so a document read over MCP can be saved again. Two copies would drift
 * into two different meanings for `framework: "next"`.
 */

import type { Build } from "./previewkit-config";
import { PREVIEWKIT_NODE_PM_CATALOG, type PreviewkitNodePmSpec } from "./previewkit-node-pm";

/** A node-family framework preset (node / next / vite / bun) - the discriminated arms that use a node package manager. */
export type NodeFrameworkBuild = Exclude<Build, { framework: "dockerfile" | "runtime" }>;

/** Narrows a stored build block to {@link NodeFrameworkBuild}, so the exclusion is stated in one place. */
export function isNodeFrameworkBuild(build: Build): build is NodeFrameworkBuild {
    return build.framework !== "dockerfile" && build.framework !== "runtime";
}

/** The resolved install / build / run / bootstrap commands for a node-family build (bare, without the `RUN`/`CMD` prefix). */
export interface NodeBuildCommands {
    /** Pre-`COPY` bootstrap (e.g. `corepack enable`), or undefined when none is needed. */
    bootstrap?: string;
    install: string;
    build: string;
    run: string;
}

/**
 * Resolves the install / build / run / bootstrap commands for a node-family build
 * from its package manager, framework, and build context - each defaulted here
 * and overridable via the build's explicit `*_command` fields. A `root` build
 * context builds/starts through the turbo `--filter` for monorepos; vite serves
 * its static preview.
 *
 * `turboFilter` is the resolved `--filter=<spec>` argument (by workspace package
 * name, path fallback). It is required for a root context and unused otherwise -
 * the caller resolves it only for root builds, so a missing filter on a root
 * build is a programming error, not a user misconfiguration.
 */
export function nodeBuildCommands(build: NodeFrameworkBuild, turboFilter?: string): NodeBuildCommands {
    const tool: PreviewkitNodePmSpec =
        build.framework === "bun" ? PREVIEWKIT_NODE_PM_CATALOG.bun : PREVIEWKIT_NODE_PM_CATALOG[build.package_manager];
    const root = build.build_context === "root";
    return {
        bootstrap: tool.bootstrap,
        install: build.install_command ?? tool.install,
        build: build.build_command ?? defaultBuildCommand(tool, root, turboFilter),
        run: build.run_command ?? defaultRunCommand(tool, root, build.framework, turboFilter),
    };
}

function defaultBuildCommand(tool: PreviewkitNodePmSpec, root: boolean, turboFilter?: string): string {
    if (!root) return `${tool.cli} run build`;
    return `${tool.turbo} run build ${requireTurboFilter(turboFilter)}`;
}

function defaultRunCommand(
    tool: PreviewkitNodePmSpec,
    root: boolean,
    framework: NodeFrameworkBuild["framework"],
    turboFilter?: string,
): string {
    if (root) return `${tool.turbo} run start ${requireTurboFilter(turboFilter)}`;
    if (framework === "vite") return `${tool.cli} run preview`;
    return `${tool.cli} start`;
}

/**
 * Asserts a root-context build was given a resolved turbo filter.
 */
function requireTurboFilter(turboFilter?: string): string {
    if (turboFilter == null) {
        throw new Error("A root build_context requires a resolved turbo --filter, but none was provided");
    }
    return turboFilter;
}
