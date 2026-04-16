import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Logger } from "@autonoma/logger";
import type { DiffAnalysis } from "./diffs-agent";

const execFileAsync = promisify(execFile);

export async function buildDiffAnalysis(
    repoDir: string,
    headSha: string,
    baseSha: string,
    logger: Logger,
): Promise<DiffAnalysis> {
    const { stdout: nameOnly } = await execFileAsync("git", ["diff", `${baseSha}..${headSha}`, "--name-only"], {
        cwd: repoDir,
        maxBuffer: 10 * 1024 * 1024,
    });

    const affectedFiles = nameOnly
        .trim()
        .split("\n")
        .filter((f) => f.length > 0);

    const { stdout: logOutput } = await execFileAsync("git", ["log", `${baseSha}..${headSha}`, "--format=%s"], {
        cwd: repoDir,
    });

    const summary = logOutput.trim();

    logger.info("Built diff analysis", { affectedFiles: affectedFiles.length, summary: summary.slice(0, 200) });
    return { affectedFiles, summary };
}
