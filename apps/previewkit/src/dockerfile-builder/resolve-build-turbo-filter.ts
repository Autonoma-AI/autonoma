import path from "node:path";
import type { Build } from "../config/schema";
import { resolveTurboFilter } from "./turbo-filter";

/** A generated build (framework preset or the raw runtime) - excludes the user-Dockerfile arm. */
type GeneratedBuild = Exclude<Build, { framework: "dockerfile" }>;

/**
 * Resolves the turbo `--filter` argument for a generated build, or undefined
 * when the build does not filter. Only a root-context node-family build filters:
 * it builds the whole monorepo from the repo root and selects this app's
 * workspace by its real `package.json` name (which the Kubernetes app name may
 * not match), with a path-based fallback. App-context builds and the raw runtime
 * escape hatch never filter.
 *
 * `repoDir` is the cloned repo on the runner; `appPath` is the app's path
 * relative to it (config `app.path`).
 */
export function resolveBuildTurboFilter(build: GeneratedBuild, repoDir: string, appPath: string): string | undefined {
    const isRootNodeBuild = build.framework !== "runtime" && build.build_context === "root";
    if (!isRootNodeBuild) return undefined;
    const appDir = path.resolve(repoDir, appPath);
    return resolveTurboFilter(appDir, path.relative(repoDir, appDir) || ".");
}
