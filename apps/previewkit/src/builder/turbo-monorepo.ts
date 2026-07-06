import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { logger } from "../logger";

const packageJsonNameSchema = z.object({ name: z.string().min(1).optional() });
const readerResultSchema = z.object({ output: z.string().optional() });

export type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

const LOCKFILES: ReadonlyArray<{ files: readonly string[]; pm: PackageManager }> = [
    { files: ["bun.lock", "bun.lockb"], pm: "bun" },
    { files: ["pnpm-lock.yaml"], pm: "pnpm" },
    { files: ["yarn.lock"], pm: "yarn" },
    { files: ["package-lock.json"], pm: "npm" },
];

/**
 * Detects the workspace package manager by lockfile presence at the monorepo
 * root. Order matters: bun.lockb is a bun binary lockfile, bun.lock is the
 * newer text format, both signal bun.
 *
 * Throws when multiple competing lockfiles are present (e.g. bun.lock and
 * pnpm-lock.yaml side-by-side) - that almost always means a stale lockfile
 * was left behind by a tooling switch, and silently picking one is how you
 * ship a build with the wrong dependency resolution. Better to fail loud.
 */
export function detectPackageManager(buildContext: string): PackageManager {
    const detected = LOCKFILES.filter((entry) => entry.files.some((f) => existsSync(join(buildContext, f))));
    if (detected.length > 1) {
        const found = detected.map((d) => d.pm).join(", ");
        throw new Error(
            `Monorepo at ${buildContext} has competing lockfiles (${found}). Remove the stale ones - this is almost always a leftover from switching package managers. Keeping both would silently resolve dependencies the wrong way.`,
        );
    }
    return detected[0]?.pm ?? "npm";
}

/**
 * Returns a `--filter=<spec>` argument for turbo. Prefers the package's
 * `name` field from package.json (turbo's canonical identifier); falls back
 * to a path-based filter when package.json is missing, unreadable, or has no
 * name field. Path-based filters always work in turbo and survive packages
 * with scoped names that don't match the directory basename.
 */
export function resolveTurboFilter(appDir: string, relAppDir: string): string {
    const pkgPath = join(appDir, "package.json");
    if (existsSync(pkgPath)) {
        try {
            const parsed = packageJsonNameSchema.safeParse(JSON.parse(readFileSync(pkgPath, "utf8")));
            if (parsed.success && parsed.data.name != null) {
                return `--filter=${parsed.data.name}`;
            }
        } catch (err) {
            logger.debug("Failed to read/parse package.json for turbo filter, falling back to path-based", {
                pkgPath,
                err,
            });
        }
    }
    return `--filter=./${relAppDir}`;
}

/**
 * Resolved path to the reader script, for the two ways the runner runs:
 * - dev: tsx from source, this file is `src/builder/turbo-monorepo.ts`, so the
 *   script is two levels up at `<pkg>/scripts/read-next-config.mjs`.
 * - prod: the rolldown bundle is a single `dist/index.js`, so every module
 *   collapses to `<pkg>/dist`, and the `copy-scripts` plugin puts the script at
 *   `<pkg>/dist/scripts/read-next-config.mjs`.
 */
const moduleDir = dirname(fileURLToPath(import.meta.url));
const READ_NEXT_CONFIG_SCRIPT =
    basename(moduleDir) === "dist"
        ? resolve(moduleDir, "scripts", "read-next-config.mjs")
        : resolve(moduleDir, "../..", "scripts", "read-next-config.mjs");

const EVAL_TIMEOUT_MS = 10_000;

/**
 * Detects Next.js standalone output (`output: 'standalone'`) by actually
 * evaluating the config file. Tries `node` first (handles .js + .mjs);
 * falls back to `bun` (handles .ts and any ESM/CJS edge cases node trips
 * on). On dual-runtime failure - typically because the config wraps a dep
 * that hasn't been installed yet, e.g. `withSentryConfig(...)` - we log a
 * warn and return false. The caller then picks the safe fallback start
 * command (`cd <dir> && <pm> run start`), which works for both standalone
 * and non-standalone builds; users who want the slimmer standalone server
 * in that case should hoist `output` to the top level of their config or
 * (future) set an explicit start_command override.
 */
export function detectNextStandalone(appDir: string): boolean {
    const candidates = ["next.config.js", "next.config.mjs", "next.config.ts"];
    const configPath = candidates.map((c) => join(appDir, c)).find(existsSync);
    if (configPath == null) return false;

    const nodeAttempt = runReader("node", [READ_NEXT_CONFIG_SCRIPT, configPath]);
    if (nodeAttempt.ok) return nodeAttempt.output === "standalone";

    const bunAttempt = runReader("bun", ["run", READ_NEXT_CONFIG_SCRIPT, configPath]);
    if (bunAttempt.ok) return bunAttempt.output === "standalone";

    logger.warn(
        "Could not evaluate next.config under either node or bun; falling back to `<pm> run start`. " +
            "If your app uses `output: 'standalone'`, hoist that setting to the top level of your config (outside any wrappers) " +
            "so it can be evaluated without the wrappers' dependencies being installed first.",
        {
            configPath,
            nodeStderr: nodeAttempt.stderr,
            bunStderr: bunAttempt.stderr,
        },
    );
    return false;
}

interface ReaderResult {
    ok: boolean;
    output?: string;
    stderr?: string;
}

function runReader(command: string, args: string[]): ReaderResult {
    const result = spawnSync(command, args, { timeout: EVAL_TIMEOUT_MS, encoding: "utf8" });
    // spawnSync sets `error` for ENOENT (binary not on PATH) and other
    // pre-exec failures. Treat those as a graceful "not ok" - the caller
    // moves on to the next runtime.
    if (result.error != null || result.status !== 0) {
        return { ok: false, stderr: result.stderr ?? result.error?.message ?? "" };
    }
    try {
        const parsed = readerResultSchema.safeParse(JSON.parse(result.stdout));
        if (!parsed.success) {
            return { ok: false, stderr: `Reader output failed schema validation: ${parsed.error.message}` };
        }
        return parsed.data.output != null ? { ok: true, output: parsed.data.output } : { ok: true };
    } catch (err) {
        return {
            ok: false,
            stderr: `Could not parse reader stdout as JSON: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
}

/**
 * Resolves the container start command. Routes Next.js standalone output to
 * `node <relAppDir>/.next/standalone/server.js`; otherwise falls back to
 * `cd <relAppDir> && <pm> run start`.
 */
export function resolveStartCommand(appDir: string, relAppDir: string, pm: PackageManager): string {
    if (detectNextStandalone(appDir)) {
        return `node ${relAppDir}/.next/standalone/server.js`;
    }
    return `cd ${relAppDir} && ${pm} run start`;
}

/**
 * Single-quote a value for safe inlining into a shell command. Wraps in
 * single quotes and escapes embedded single quotes the standard POSIX way
 * (`'\''`). Lets us inline build-arg values that may contain spaces, URLs
 * with `&`/`?`, or quotes without breaking the command line.
 */
export function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Manifests at the monorepo root that would make railpack auto-detect a
 * non-Node provider (Rust, Python, Ruby, Go, Java/Kotlin) and generate a
 * totally wrong build plan for a JS/TS workspace. Sandstone's `Cargo.toml`
 * for its CLI + subgraph-core Rust crates is the motivating real-world
 * example - without an override, railpack tries to `cargo build` the
 * Next.js apps.
 */
const NON_NODE_ROOT_MANIFESTS = [
    "Cargo.toml",
    "requirements.txt",
    "pyproject.toml",
    "Pipfile",
    "Gemfile",
    "go.mod",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
] as const;

/**
 * Returns the list of non-Node manifests present at the monorepo root, in
 * declaration order. Empty array means the repo looks purely Node-ish and no
 * provider override is strictly necessary (but we still write one - it
 * guards against future drift cheaply).
 */
export function detectNonNodeRootManifests(buildContext: string): string[] {
    return NON_NODE_ROOT_MANIFESTS.filter((m) => existsSync(join(buildContext, m)));
}

/**
 * Writes `railpack.json` with `{"provider": "node"}` at the monorepo root if
 * no railpack.json already exists. Returns a cleanup function that removes
 * the file only when we were the ones who wrote it - existing user configs
 * are left untouched.
 *
 * Why this exists: railpack auto-detects providers from root manifests.
 * Real-world JS/TS monorepos (Sandstone) ship a `Cargo.toml` at the root
 * for tooling/auxiliary crates, which makes railpack pick Rust and generate
 * a build plan that can't possibly build a Next.js app. Forcing Node here
 * is the simplest fix that doesn't require railpack changes upstream.
 */
export async function provisionRailpackNodeOverride(buildContext: string): Promise<() => Promise<void>> {
    const railpackConfigPath = join(buildContext, "railpack.json");
    if (existsSync(railpackConfigPath)) {
        // Respect existing config - if the user shipped a railpack.json
        // they almost certainly mean it. The override would silently
        // change their build.
        return async () => {};
    }
    await writeFile(railpackConfigPath, JSON.stringify({ provider: "node" }), "utf8");
    return async () => {
        await rm(railpackConfigPath, { force: true }).catch((err) => {
            logger.warn("Failed to clean up provisional railpack.json", { railpackConfigPath, err });
        });
    };
}

export interface TurboMonorepoBuildPlan {
    pm: PackageManager;
    relAppDir: string;
    filterArg: string;
    startCmd: string;
    buildCmd: string;
}

/**
 * Pure planning step for a turbo monorepo build. Computes everything that
 * gets passed to `railpack prepare` without touching anything other than the
 * filesystem for detection. The caller is responsible for actually invoking
 * railpack and buildctl with the result.
 */
export function planTurboMonorepoBuild(params: {
    buildContext: string;
    contextPath: string;
    buildArgs: Record<string, string>;
}): TurboMonorepoBuildPlan {
    const relAppDir = relative(params.buildContext, params.contextPath) || ".";
    // BuildKit's --local context= only ships files under buildContext to the
    // builder. An app dir outside that tree wouldn't be reachable from the
    // build, and a `--filter=./../foo` is not a valid turbo filter anyway.
    if (relAppDir.startsWith("..")) {
        throw new Error(
            `App context ${params.contextPath} is outside the monorepo root ${params.buildContext}. The app directory must live inside the monorepo so buildctl can ship it as part of the build context.`,
        );
    }
    const pm = detectPackageManager(params.buildContext);
    const filterArg = resolveTurboFilter(params.contextPath, relAppDir);
    const startCmd = resolveStartCommand(params.contextPath, relAppDir, pm);

    // Inline build args as a `KEY='VALUE' ...` prefix to the build command.
    // Railpack's --env flag only applies to the install step; NEXT_PUBLIC_*
    // vars must be in the env when `next build` runs, which happens during
    // this command.
    const argPrefix = Object.entries(params.buildArgs)
        .map(([k, v]) => `${k}=${shellQuote(v)}`)
        .join(" ");
    const turboCmd = `${pm} run turbo run build ${filterArg}`;
    const buildCmd = argPrefix.length > 0 ? `${argPrefix} ${turboCmd}` : turboCmd;

    return { pm, relAppDir, filterArg, startCmd, buildCmd };
}
