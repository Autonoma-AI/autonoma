import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { debugLog } from "../../core/debug";
import type { ProjectMap } from "../../core/project-map";

/** Dependency/build artifacts - never part of the app's structure. */
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", "out", "target", "vendor"]);
/** How deep to look for an uncovered directory before giving up on precision. */
const MAX_DEPTH = 2;
/** Cap the report so a pathological tree doesn't flood the agent's context. */
const MAX_REPORTED = 12;

/**
 * Directories the map does not account for. The mapper is an LLM and samples
 * the tree differently on every run - this is the mechanical backstop that
 * makes its output consistent: every directory must be inside some entry
 * (frontend, backend, or ignore), or it comes back here and the agent must
 * classify it explicitly. Recurses into partially-covered parents (an `apps/`
 * with two of three children mapped reports exactly the third child).
 */
export async function findUncoveredDirs(projectRoot: string, map: ProjectMap): Promise<string[]> {
    const entries = [...map.frontends, ...map.backends, ...map.ignore].map((e) =>
        e.path.replace(/^\.\//, "").replace(/\/+$/, ""),
    );
    // An entry for the repo root covers everything (single fullstack app).
    if (entries.some((e) => e === "." || e === "")) return [];

    const underEntry = (rel: string): boolean => entries.some((e) => e === rel || rel.startsWith(`${e}/`));
    const hasEntryWithin = (rel: string): boolean => entries.some((e) => e.startsWith(`${rel}/`));

    const out: string[] = [];

    async function walk(abs: string, rel: string, depth: number): Promise<void> {
        let children: Dirent[];
        try {
            children = await readdir(abs, { withFileTypes: true });
        } catch (err) {
            debugLog("Coverage walk could not read a directory, skipping it", { abs, err });
            return;
        }
        for (const child of children) {
            if (out.length >= MAX_REPORTED) return;
            if (!child.isDirectory()) continue;
            if (child.name.startsWith(".") || SKIP_DIRS.has(child.name)) continue;
            const childRel = rel === "" ? child.name : `${rel}/${child.name}`;
            if (underEntry(childRel)) continue;
            if (hasEntryWithin(childRel)) {
                // Partially covered (e.g. apps/ with some children mapped):
                // descend to name exactly what is missing; past the depth cap,
                // let it pass rather than report a parent that is mostly mapped.
                if (depth + 1 < MAX_DEPTH) await walk(join(abs, child.name), childRel, depth + 1);
            } else {
                out.push(childRel);
            }
        }
    }

    await walk(projectRoot, "", 0);
    return out;
}
