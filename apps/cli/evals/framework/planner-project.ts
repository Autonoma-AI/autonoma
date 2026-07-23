import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type CheckoutCoords, ensureCachedCheckout } from "./checkout";
import { stageContextCheckout } from "./context-repos";
import { copyTree, git } from "./git";

/**
 * Stage the tree the planner (Layer 1) analyzes, with `strip.patch` applied to the
 * target checkout so the planner runs against the clean baseline.
 *
 * The planner takes a single `--project` root and discovers `--frontend`/`--backends`
 * as SUBDIRECTORIES of it, so the two shapes are:
 *
 * - **single-repo** (no context repos): the project root IS the stripped target
 *   checkout, exactly as the harness has always done.
 * - **multi-repo** (context repos present): every repo is copied to a sibling subdir
 *   under one neutral root, named by its bare repo name, so the project mapper can
 *   discover each as a frontend/backend candidate. `strip.patch` is applied only to
 *   the target subdir; the caller selects the frontend/backends by those subdir names
 *   (e.g. `--frontend <frontend-repo> --backends <target-repo>`).
 */
export interface PlannerProject {
    /** Pass this as the planner's `--project`. */
    projectRoot: string;
    /** True when the root is a combined multi-repo tree (target + context siblings). */
    multiRepo: boolean;
}

export async function preparePlannerProject(params: {
    caseRepo: string;
    coords: CheckoutCoords;
    contextRepos: CheckoutCoords[];
    stripPatchPath: string;
    runDir: string;
}): Promise<PlannerProject> {
    const { caseRepo, coords, contextRepos, stripPatchPath, runDir } = params;

    if (contextRepos.length === 0) {
        const projectRoot = join(runDir, "sandbox");
        const cacheDir = await ensureCachedCheckout(coords);
        await copyTree(cacheDir, projectRoot);
        await git(projectRoot, ["apply", "--whitespace=nowarn", stripPatchPath]);
        return { projectRoot, multiRepo: false };
    }

    const projectRoot = join(runDir, "project");
    mkdirSync(projectRoot, { recursive: true });

    const targetCache = await ensureCachedCheckout(coords);
    const targetDir = join(projectRoot, coords.repo);
    await copyTree(targetCache, targetDir);
    await git(targetDir, ["apply", "--whitespace=nowarn", stripPatchPath]);

    await Promise.all(contextRepos.map((ctx) => stageContextCheckout(caseRepo, ctx, join(projectRoot, ctx.repo))));

    return { projectRoot, multiRepo: true };
}
