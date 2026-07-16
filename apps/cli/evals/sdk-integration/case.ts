import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CheckoutCoords } from "../framework/checkout";
import { loadCoords } from "../framework/corpus";
import { artifactsDir, caseDir } from "../framework/paths";

export interface LoadedCase {
    repo: string;
    coords: CheckoutCoords;
    /** `cases/<repo>/strip.patch` - sha -> clean (SDK removed). */
    stripPatchPath: string;
    /** `cases/<repo>/artifacts/` - the frozen planner artifacts fed to the agent. */
    artifactsDir: string;
}

const STRIP_PATCH = "strip.patch";

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
    return { repo, coords, stripPatchPath, artifactsDir: artifacts };
}
