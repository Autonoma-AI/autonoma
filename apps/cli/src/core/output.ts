import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { debugLog } from "./debug";

/**
 * Everything this CLI keeps between runs. Per-project output lives in a directory
 * under it; anything about the machine rather than a project sits alongside those.
 */
export const AUTONOMA_HOME = join(homedir(), ".autonoma");

/** Probe file the writability check writes and removes. */
const WRITE_PROBE_FILE = ".write-probe";

export function slugify(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

export function getOutputDir(projectSlug: string): string {
    return join(AUTONOMA_HOME, projectSlug);
}

/**
 * Empty a run's output directory, leaving the directory itself in place.
 *
 * Clears the whole directory rather than the artifacts it can name: steps decide
 * they are already done by finding their own output, so anything left behind
 * makes a fresh run continue the previous one, and a cleanup list kept in sync by
 * hand goes stale as soon as an artifact is added. Only per-app derived state
 * lives here - credentials and the analytics id are at the AUTONOMA_HOME root and
 * are not touched.
 */
export async function clearOutputDir(projectSlug: string): Promise<void> {
    const dir = getOutputDir(projectSlug);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    debugLog("Cleared the run directory for a fresh start", { dir });
}

/**
 * An absolute path as a human would write it. Every output path lives under the
 * home directory, so printing it in full spends a third of the line on
 * something the reader already knows.
 */
export function displayPath(absPath: string): string {
    const home = homedir();
    return absPath.startsWith(home) ? `~${absPath.slice(home.length)}` : absPath;
}

/**
 * Create the run's output directory and prove we can actually write into it.
 *
 * A run reaches its first real write minutes in and its last one hours in, and
 * every artifact it produces - the knowledge base, the recipe, every generated
 * test - only exists as a file here. A directory that cannot be written to fails
 * the same way at any point in that window, so find out before the user has spent
 * an hour on a run whose output has nowhere to go.
 *
 * `access(W_OK)` is not enough: it answers a permissions question, and the
 * failures that matter (a full disk, a read-only mount, a quota) only surface
 * when bytes are written. So write bytes.
 */
export async function ensureOutputDir(projectSlug: string): Promise<string> {
    const dir = getOutputDir(projectSlug);
    await mkdir(dir, { recursive: true });

    const probe = join(dir, WRITE_PROBE_FILE);
    try {
        await writeFile(probe, "ok", "utf-8");
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(
            `Cannot write to ${displayPath(dir)} - the planner keeps every artifact it generates there.\n` +
                `  ${reason}\n` +
                `  Free up disk space or fix the directory's permissions, then re-run.`,
        );
    }
    await rm(probe, { force: true }).catch((err) => {
        // A leftover probe is harmless: it is dotted, so nothing treats it as an
        // artifact. Worth a breadcrumb though - a directory that accepts writes
        // but refuses deletes will bite the review cycle later.
        debugLog("Could not remove the write probe", { probe, err });
    });

    return dir;
}

export async function ensureSubDir(projectSlug: string, ...parts: string[]): Promise<string> {
    const dir = join(getOutputDir(projectSlug), ...parts);
    await mkdir(dir, { recursive: true });
    return dir;
}
