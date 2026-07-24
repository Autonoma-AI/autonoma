import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckoutCoords } from "../framework/checkout";
import { loadContextRepos, loadCoords } from "../framework/corpus";
import { artifactsDir, caseDir } from "../framework/paths";

export interface LoadedCase {
    repo: string;
    coords: CheckoutCoords;
    /**
     * Read-only sibling repos (polyrepo apps): cloned and exposed to the agent as
     * context, stripped (via context-strips/) but never graded. Empty for single-repo cases.
     */
    contextRepos: CheckoutCoords[];
    /** `cases/<repo>/strip.patch` - sha -> clean (SDK removed). */
    stripPatchPath: string;
    /** `cases/<repo>/artifacts/` - the frozen planner artifacts fed to the agent. */
    artifactsDir: string;
    /**
     * Contents of the optional `cases/<repo>/agent-notes.md`, appended verbatim to the driven
     * agent's drive prompt when present. This is the ONLY per-case channel for instructing the
     * driven agent (e.g. a repo-specific seeding convention); most cases have none. Unlike
     * `ENV.md` (human-only, never read by the agent), this file IS fed to the agent.
     */
    agentNotes?: string;
}

const STRIP_PATCH = "strip.patch";
const AGENT_NOTES = "agent-notes.md";

/**
 * Load a case folder for a Layer-2 run. Throws with a precise message when a
 * required file is missing rather than failing deep in the run.
 *
 * There is no per-repo boot config: getting the app running locally is the driven
 * agent's own best-effort job (it discovers the stack and start command itself).
 */
export function loadCase(repo: string): LoadedCase {
    const stripPatchPath = join(caseDir(repo), STRIP_PATCH);
    const artifacts = artifactsDir(repo);

    if (!existsSync(stripPatchPath)) {
        throw new Error(`Case "${repo}" is missing ${STRIP_PATCH} (expected at ${stripPatchPath}).`);
    }
    if (!existsSync(artifacts)) {
        throw new Error(`Case "${repo}" has no artifacts dir at ${artifacts}.`);
    }

    const coords = loadCoords(repo);
    const contextRepos = loadContextRepos(repo);
    const notesPath = join(caseDir(repo), AGENT_NOTES);
    const agentNotes = existsSync(notesPath) ? readFileSync(notesPath, "utf-8").trim() : undefined;
    return { repo, coords, contextRepos, stripPatchPath, artifactsDir: artifacts, agentNotes };
}
