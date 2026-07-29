import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const AUTONOMA_HOME = join(homedir(), ".autonoma");

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
 * An absolute path as a human would write it. Every output path lives under the
 * home directory, so printing it in full spends a third of the line on
 * something the reader already knows.
 */
export function displayPath(absPath: string): string {
    const home = homedir();
    return absPath.startsWith(home) ? `~${absPath.slice(home.length)}` : absPath;
}

export async function ensureOutputDir(projectSlug: string): Promise<string> {
    const dir = getOutputDir(projectSlug);
    await mkdir(dir, { recursive: true });
    return dir;
}

export async function ensureSubDir(projectSlug: string, ...parts: string[]): Promise<string> {
    const dir = join(getOutputDir(projectSlug), ...parts);
    await mkdir(dir, { recursive: true });
    return dir;
}
