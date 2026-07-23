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

const inputSchema = coordsSchema.extend({
    /**
     * Other repos in a polyrepo app, made available read-only alongside the target.
     * The SDK integration lands in (and is graded against) the target repo only; these
     * are here so the agent and planner can read the rest of the app to understand its
     * models and their real creation paths. Their roles (which is a frontend, which a
     * backend) are discovered by the planner's mapper, not declared here. SHAs are
     * pinned for reproducibility. Never stripped, never graded.
     */
    contextRepos: z.array(coordsSchema).optional(),
});

function readInput(repo: string): z.infer<typeof inputSchema> {
    const path = join(caseDir(repo), "input.json");
    if (!existsSync(path)) {
        throw new Error(`Case "${repo}" is missing input.json (expected at ${path}).`);
    }
    return inputSchema.parse(JSON.parse(readFileSync(path, "utf-8")));
}

/** Parse `cases/<repo>/input.json` into the target repo's checkout coordinates. */
export function loadCoords(repo: string): CheckoutCoords {
    const input = readInput(repo);
    return { owner: input.owner, repo: input.repo, sha: input.sha, installationId: input.installationId };
}

/** Parse the optional read-only context repos from `cases/<repo>/input.json` (empty if none). */
export function loadContextRepos(repo: string): CheckoutCoords[] {
    return readInput(repo).contextRepos ?? [];
}

/**
 * `cases/<repo>/context-strips/<contextRepo>.patch` - the optional strip for one context repo
 * (sha -> clean, SDK integration removed), keyed by bare repo name. A context repo must meet the
 * same realism bar as the target: no `autonoma` references in the staged tree. When the pinned
 * context sha already predates the integration this file is absent and nothing is stripped.
 */
export function contextStripPatchPath(repo: string, contextRepo: string): string {
    return join(caseDir(repo), "context-strips", `${contextRepo}.patch`);
}

/** `cases/<repo>/context.json` - the planner's saved project context for a non-interactive run. */
export function contextPath(repo: string): string {
    return join(caseDir(repo), "context.json");
}

/** `cases/<repo>/rubrics/<step>.md` - the authored findings rubric for a planner step. */
export function rubricPath(repo: string, step: string): string {
    return join(caseDir(repo), "rubrics", `${step}.md`);
}
