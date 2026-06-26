import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger as rootLogger } from "@autonoma/logger";
import type { PreviewAccess } from "../classify/dependencies";
import type { PreviewSecrets } from "./preview-secrets";

/** The slice of PreviewSecrets this needs (so it's testable with a fake secret source). */
type PreviewSecretSource = Pick<PreviewSecrets, "getEnvVarNames" | "getEnvValues">;

const SCRIPT_TIMEOUT_MS = 60_000;

/**
 * Implements PreviewAccess for a PR's preview deployment: lists its configured env-var names, and runs a
 * throwaway Node script against its live backend with the preview's OWN credentials injected.
 *
 * WARNING: runScript executes arbitrary `npm install` + `node` inside the worker pod with the preview's
 * credentials. It runs in a fresh temp dir that is always cleaned up, the model is instructed to be
 * read-only, and execution is time-bounded - but this is real code execution. If we ever run untrusted
 * input through it, sandbox it (gVisor / a restricted runner) instead of trusting the prompt.
 */
export class PreviewEnvironment implements PreviewAccess {
    private readonly logger = rootLogger.child({ name: "PreviewEnvironment" });

    constructor(
        private readonly secrets: PreviewSecretSource,
        public readonly repoFullName: string,
        public readonly namespace?: string,
    ) {}

    async getEnvVarNames(filter?: string): Promise<string[]> {
        const names = await this.secrets.getEnvVarNames(this.repoFullName);
        if (filter == null || filter === "") return names;
        const needle = filter.toLowerCase();
        return names.filter((name) => name.toLowerCase().includes(needle));
    }

    async runScript(input: { script: string; packages?: string[] }): Promise<string> {
        const previewEnv = await this.secrets.getEnvValues(this.repoFullName);
        const workDir = await mkdtemp(join(tmpdir(), "investigation-script-"));
        this.logger.info("Running preview script", { extra: { workDir, packages: input.packages ?? [] } });
        try {
            await writeFile(join(workDir, "index.mjs"), input.script, "utf8");
            if (input.packages != null && input.packages.length > 0) {
                await this.runProcess("npm", ["install", "--no-save", ...input.packages], workDir, process.env);
            }
            // Inject the PREVIEW's env (so the script hits the same backend the test did); keep only PATH/HOME
            // from the worker so node resolves - do NOT leak the worker's own credentials into the script.
            const scriptEnv = { PATH: process.env.PATH, HOME: process.env.HOME, ...previewEnv };
            return await this.runProcess("node", ["index.mjs"], workDir, scriptEnv);
        } finally {
            await rm(workDir, { recursive: true, force: true }).catch((error) =>
                this.logger.warn("Failed to clean up script dir", { extra: { workDir }, err: error }),
            );
        }
    }

    private runProcess(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
        return new Promise((resolve, reject) => {
            const child = spawn(command, args, { cwd, env });
            let stdout = "";
            let stderr = "";
            const timer = setTimeout(() => {
                child.kill("SIGKILL");
                reject(new Error(`${command} timed out after ${SCRIPT_TIMEOUT_MS}ms`));
            }, SCRIPT_TIMEOUT_MS);

            child.stdout?.on("data", (chunk) => {
                stdout += String(chunk);
            });
            child.stderr?.on("data", (chunk) => {
                stderr += String(chunk);
            });
            child.on("error", (error) => {
                clearTimeout(timer);
                reject(error);
            });
            child.on("close", (code) => {
                clearTimeout(timer);
                if (code === 0) {
                    resolve(stdout.trim() !== "" ? stdout : "(script produced no output)");
                    return;
                }
                reject(new Error(`${command} exited with code ${code}: ${stderr.slice(0, 2000)}`));
            });
        });
    }
}
