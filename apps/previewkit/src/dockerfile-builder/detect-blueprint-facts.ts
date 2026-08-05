import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { PREVIEWKIT_NODE_PM_IDS, previewkitPresetSpec, type PreviewkitNodePm } from "@autonoma/types";
import { z } from "zod";
import type { Blueprint, BlueprintFacts } from "../config/schema";
import { type Logger, logger as rootLogger } from "../logger";
import { resolveTurboFilter } from "./turbo-filter";

const packageManagerFieldSchema = z.object({ packageManager: z.string().optional() });

/**
 * Lockfiles that signal each package manager. Order matters within an entry:
 * bun.lockb is a bun binary lockfile, bun.lock is the newer text format, both
 * signal bun.
 */
const LOCKFILES: ReadonlyArray<{ files: readonly string[]; pm: PreviewkitNodePm }> = [
    { files: ["bun.lock", "bun.lockb"], pm: "bun" },
    { files: ["pnpm-lock.yaml"], pm: "pnpm" },
    { files: ["yarn.lock"], pm: "yarn" },
    { files: ["package-lock.json"], pm: "npm" },
];

/**
 * Charset a repo-relative app path must satisfy before it is interpolated into the
 * generated Dockerfile (a bash `cd` line inside the build-script heredoc and a
 * `WORKDIR`) - anything else could break out of either.
 */
const SAFE_APP_PATH = /^[A-Za-z0-9@._/-]+$/;

/**
 * Detects the {@link BlueprintFacts} for an app's blueprint build: the node package
 * manager of the build context (the `packageManager` field wins, then the lockfile,
 * then npm), whether that manager's lockfile is present, the repo-relative app path,
 * and - for a root build of a node preset in a turbo repo - the resolved turbo
 * `--filter`. The pure lowering in @autonoma/types cannot read the clone, so the
 * pipeline runs this and passes the result in.
 */
export function detectBlueprintFacts(blueprint: Blueprint, repoDir: string, appPath: string): BlueprintFacts {
    const logger = rootLogger.child({ name: "detectBlueprintFacts" });
    const root = blueprint.build_context === "root";
    const appDir = resolve(repoDir, appPath);
    const contextDir = root ? repoDir : appDir;
    const relApp = root ? relative(repoDir, appDir) || "." : ".";
    if (!SAFE_APP_PATH.test(relApp)) {
        throw new Error(`App path "${relApp}" contains characters the generated Dockerfile cannot carry safely`);
    }

    const { packageManager, hasLockfile } = detectNodePm(contextDir, logger);
    const isNodePreset = "preset" in blueprint && previewkitPresetSpec(blueprint.preset).toolchain === "node";
    const turboFilter =
        root && isNodePreset && existsSync(join(repoDir, "turbo.json"))
            ? resolveTurboFilter(appDir, relApp)
            : undefined;

    const facts: BlueprintFacts = { packageManager, hasLockfile, appPath: relApp, turboFilter };
    logger.info("Detected blueprint repo facts", {
        extra: { packageManager, hasLockfile, appPath: relApp, turboFilter },
    });
    return facts;
}

function detectNodePm(contextDir: string, logger: Logger): Pick<BlueprintFacts, "packageManager" | "hasLockfile"> {
    const field = packageManagerField(contextDir, logger);
    const lockfilePm = detectLockfilePm(contextDir);
    const chosen = field ?? lockfilePm ?? "npm";
    // The blueprint node toolchain builds on the node runtime image, which does not
    // ship bun - fall back to npm rather than generate a script that cannot run.
    if (chosen === "bun") {
        logger.warn("bun detected but unavailable on the node runtime image - using npm", {
            extra: { contextDir, field, lockfilePm },
        });
        return { packageManager: "npm", hasLockfile: false };
    }
    return { packageManager: chosen, hasLockfile: lockfilePm === chosen };
}

/**
 * The package manager signalled by a lockfile in `dir`, or undefined when none is
 * present. Throws on competing lockfiles (e.g. bun.lock and pnpm-lock.yaml
 * side-by-side) - that almost always means a stale lockfile was left behind by a
 * tooling switch, and silently picking one is how you ship a build with the wrong
 * dependency resolution. Better to fail loud.
 */
function detectLockfilePm(dir: string): PreviewkitNodePm | undefined {
    const detected = LOCKFILES.filter((entry) => entry.files.some((f) => existsSync(join(dir, f))));
    if (detected.length > 1) {
        const found = detected.map((d) => d.pm).join(", ");
        throw new Error(
            `Build context at ${dir} has competing lockfiles (${found}). Remove the stale ones - this is almost always a leftover from switching package managers. Keeping both would silently resolve dependencies the wrong way.`,
        );
    }
    return detected[0]?.pm;
}

/** The package manager pinned by the context's package.json `packageManager` field (corepack), if any. */
function packageManagerField(contextDir: string, logger: Logger): PreviewkitNodePm | undefined {
    const pkgPath = join(contextDir, "package.json");
    if (!existsSync(pkgPath)) return undefined;
    try {
        const parsed = packageManagerFieldSchema.safeParse(JSON.parse(readFileSync(pkgPath, "utf8")));
        const field = parsed.success ? parsed.data.packageManager : undefined;
        const name = field?.split("@")[0];
        return name != null && isNodePm(name) ? name : undefined;
    } catch (err) {
        logger.debug("Failed to read package.json packageManager field", { extra: { pkgPath, err } });
        return undefined;
    }
}

function isNodePm(value: string): value is PreviewkitNodePm {
    const ids: readonly string[] = PREVIEWKIT_NODE_PM_IDS;
    return ids.includes(value);
}
