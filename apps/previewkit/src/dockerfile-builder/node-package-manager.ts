import type { Build } from "../config/schema";

/** A node-family framework preset (node / next / vite / bun) - the discriminated arms that use a node package manager. */
type NodeFrameworkBuild = Exclude<Build, { framework: "dockerfile" | "runtime" }>;

/** The resolved install / build / run / bootstrap commands for a node-family build (bare, without the `RUN`/`CMD` prefix). */
export interface NodeBuildCommands {
    /** Pre-`COPY` bootstrap (e.g. `corepack enable`), or undefined when none is needed. */
    bootstrap?: string;
    install: string;
    build: string;
    run: string;
}

interface NodeToolStrategy {
    /** CLI prefix (`pnpm`, `bun`, ...). */
    cli: string;
    /** Bootstrap command needed before install (corepack for pnpm/yarn), or undefined. */
    bootstrap?: string;
    /** Default install command. */
    install: string;
    /**
     * Prefix that invokes the local `turbo` binary for this package manager. Not
     * uniform: `${cli} turbo` runs the binary for pnpm/yarn but is invalid for npm
     * (`npm turbo` is not a command) and wrong for bun (`bun turbo` runs a script).
     * The turbo args (`run build --filter=...`) are appended to this prefix; npm's
     * trailing `--` forwards them past `npm exec`.
     */
    turbo: string;
}

/**
 * Node package-manager strategies. npm ships with node and bun ships in its own
 * image, so neither needs a bootstrap; pnpm/yarn activate through corepack.
 * Adding a manager is one entry here, not a branch in the generator.
 */
const NODE_TOOLS = {
    npm: { cli: "npm", install: "npm ci", turbo: "npm exec turbo --" },
    pnpm: {
        cli: "pnpm",
        bootstrap: "corepack enable",
        install: "pnpm install --frozen-lockfile",
        turbo: "pnpm exec turbo",
    },
    yarn: { cli: "yarn", bootstrap: "corepack enable", install: "yarn install --frozen-lockfile", turbo: "yarn turbo" },
    bun: { cli: "bun", install: "bun install", turbo: "bunx turbo" },
} satisfies Record<string, NodeToolStrategy>;

/**
 * Resolves the install / build / run / bootstrap commands for a node-family build
 * from its package manager, framework, and build context - each defaulted here
 * and overridable via the build's explicit `*_command` fields. `build_context:
 * root` builds/starts through a turbo `--filter` for monorepos; vite serves its
 * static preview.
 */
export function nodeBuildCommands(build: NodeFrameworkBuild, appName: string): NodeBuildCommands {
    const tool: NodeToolStrategy = build.framework === "bun" ? NODE_TOOLS.bun : NODE_TOOLS[build.package_manager];
    const root = build.build_context === "root";
    return {
        bootstrap: tool.bootstrap,
        install: build.install_command ?? tool.install,
        build: build.build_command ?? defaultBuildCommand(tool, appName, root),
        run: build.run_command ?? defaultRunCommand(tool, appName, root, build.framework),
    };
}

function defaultBuildCommand(tool: NodeToolStrategy, appName: string, root: boolean): string {
    return root ? `${tool.turbo} run build --filter=${appName}` : `${tool.cli} run build`;
}

function defaultRunCommand(
    tool: NodeToolStrategy,
    appName: string,
    root: boolean,
    framework: NodeFrameworkBuild["framework"],
): string {
    if (root) return `${tool.turbo} run start --filter=${appName}`;
    if (framework === "vite") return `${tool.cli} run preview`;
    return `${tool.cli} start`;
}
