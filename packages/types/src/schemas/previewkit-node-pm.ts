/**
 * Node package-manager strategies shared by every previewkit build path - the
 * `build` framework command resolution (previewkit-node-build.ts) and the
 * `blueprint` lowering (previewkit-config.ts) - so install and turbo command
 * shapes have one source of truth. npm ships with node and bun ships in its own
 * image, so neither needs a bootstrap; pnpm/yarn activate through corepack.
 */

export const PREVIEWKIT_NODE_PM_IDS = ["npm", "pnpm", "yarn", "bun"] as const;

export type PreviewkitNodePm = (typeof PREVIEWKIT_NODE_PM_IDS)[number];

/**
 * The package managers a blueprint build can detect and run. Excludes bun: the
 * blueprint node toolchain builds on the node runtime image, which does not ship
 * the bun binary (bun apps use the `build` model's dedicated bun framework).
 */
export type BlueprintNodePm = Exclude<PreviewkitNodePm, "bun">;

export interface PreviewkitNodePmSpec {
    /** CLI prefix (`pnpm`, `bun`, ...). */
    cli: string;
    /** Bootstrap command needed before install (corepack for pnpm/yarn), or undefined. */
    bootstrap?: string;
    /** Strict install - requires a lockfile (`npm ci`, `--frozen-lockfile`). */
    install: string;
    /** Tolerant install for a build context without a lockfile. */
    installNoLockfile: string;
    /**
     * Prefix that invokes the local `turbo` binary for this package manager. Not
     * uniform: `${cli} turbo` runs the binary for pnpm/yarn but is invalid for npm
     * (`npm turbo` is not a command) and wrong for bun (`bun turbo` runs a script).
     * The turbo args (`run build --filter=...`) are appended to this prefix; npm's
     * trailing `--` forwards them past `npm exec`.
     */
    turbo: string;
}

export const PREVIEWKIT_NODE_PM_CATALOG: Record<PreviewkitNodePm, PreviewkitNodePmSpec> = {
    npm: {
        cli: "npm",
        install: "npm ci",
        installNoLockfile: "npm install",
        turbo: "npm exec turbo --",
    },
    pnpm: {
        cli: "pnpm",
        bootstrap: "corepack enable",
        install: "pnpm install --frozen-lockfile",
        installNoLockfile: "pnpm install",
        turbo: "pnpm exec turbo",
    },
    yarn: {
        cli: "yarn",
        bootstrap: "corepack enable",
        install: "yarn install --frozen-lockfile",
        installNoLockfile: "yarn install",
        turbo: "yarn turbo",
    },
    bun: {
        cli: "bun",
        install: "bun install",
        installNoLockfile: "bun install",
        turbo: "bunx turbo",
    },
};
