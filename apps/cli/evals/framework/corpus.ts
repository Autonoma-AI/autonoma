import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { CheckoutCoords } from "./checkout";
import { caseDir } from "./paths";

/**
 * Shared reads over the per-repo corpus (`cases/<repo>/`), used by both eval
 * layers. The corpus is the single source of truth per repo: coordinates, the
 * strip patch, the project context, the per-step findings rubrics, and the
 * frozen artifacts.
 */

const coordsSchema = z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    /** The chosen commit carrying the client's SDK integration (= golden). */
    sha: z.string().min(1),
    /** GitHub App installation id on the client org. */
    installationId: z.number().int().positive(),
});

/** Parse `cases/<repo>/input.json` into checkout coordinates. */
export function loadCoords(repo: string): CheckoutCoords {
    const path = join(caseDir(repo), "input.json");
    if (!existsSync(path)) {
        throw new Error(`Case "${repo}" is missing input.json (expected at ${path}).`);
    }
    return coordsSchema.parse(JSON.parse(readFileSync(path, "utf-8")));
}

/** `cases/<repo>/context.json` - the planner's saved project context for a non-interactive run. */
export function contextPath(repo: string): string {
    return join(caseDir(repo), "context.json");
}

/** `cases/<repo>/rubrics/<step>.md` - the authored findings rubric for a planner step. */
export function rubricPath(repo: string, step: string): string {
    return join(caseDir(repo), "rubrics", `${step}.md`);
}
