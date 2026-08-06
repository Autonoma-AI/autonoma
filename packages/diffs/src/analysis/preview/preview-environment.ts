import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger as rootLogger } from "@autonoma/logger";
import type { PreviewEnvAccess, PreviewScriptAccess } from "../classify/types";
import { filterEnvVarNames } from "./filter-env-var-names";

/**
 * The preview-secret reads this needs - `PreviewSecrets` from `@autonoma/secrets`
 * satisfies it. Named structurally rather than imported so this package depends on
 * the behaviour, not on whichever store the values come out of.
 */
interface PreviewSecretSource {
    getEnvVarNames(target: PreviewTarget, before?: Date): Promise<string[]>;
    getEnvValues(target: PreviewTarget): Promise<Record<string, string>>;
}

/** Identifies the preview to read: the Application that owns it, and nothing inferred. */
interface PreviewTarget {
    applicationId: string;
}

const SCRIPT_TIMEOUT_MS = 60_000;

/**
 * A PR's preview deployment: lists its configured env-var names, and runs a throwaway Node script against its
 * live backend with the preview's OWN credentials injected. It satisfies both capabilities, so a live
 * classification hands the same instance to each slot.
 *
 * WARNING: runScript executes arbitrary `npm install` + `node` inside the worker pod with the preview's
 * credentials. It runs in a fresh temp dir that is always cleaned up, the model is instructed to be
 * read-only, and execution is time-bounded - but this is real code execution. If we ever run untrusted
 * input through it, sandbox it (gVisor / a restricted runner) instead of trusting the prompt.
 */
export class PreviewEnvironment implements PreviewEnvAccess, PreviewScriptAccess {
    private readonly logger = rootLogger.child({ name: "PreviewEnvironment" });

    constructor(
        private readonly secrets: PreviewSecretSource,
        /** The Application that owns this preview, so its secrets are never resolved by repo name alone. */
        private readonly applicationId: string,
        /**
         * The connection keys this PR's deployed config declares. A preview pod's environment is the app's
         * secret bundle PLUS these, and on a collision the connection WINS (previewkit mounts secrets via
         * `envFrom` and connections via `env:`). They are listed here so an absent name is a real absence
         * rather than an artifact of only reading half the environment.
         */
        private readonly connectionKeys: readonly string[] = [],
        /**
         * Lists the names as they stood at this instant rather than now. Left undefined by a live
         * classification, which wants the bundle its pods are running with; set only when freezing a PAST
         * classification, where a key added since would read as configured on a run that saw it ABSENT.
         *
         * Bounds the NAME listing only - `runScript` always injects current values, which is what querying a
         * live backend means.
         */
        private readonly namesBefore?: Date,
    ) {}

    private get target(): PreviewTarget {
        return { applicationId: this.applicationId };
    }

    async getEnvVarNames(filter?: string): Promise<string[]> {
        const secretNames = await this.secrets.getEnvVarNames(this.target, this.namesBefore);
        const names = [...new Set([...secretNames, ...this.connectionKeys])].sort();
        return filterEnvVarNames(names, filter);
    }

    async runScript(input: { script: string; packages?: string[] }): Promise<string> {
        const previewEnv = await this.secrets.getEnvValues(this.target);
        const workDir = await mkdtemp(join(tmpdir(), "investigation-script-"));
        this.logger.info("Running preview script", { extra: { workDir, packages: input.packages ?? [] } });
        try {
            await writeFile(join(workDir, "index.mjs"), input.script, "utf8");
            // The worker's own env is NEVER handed to npm: `packages` is model-chosen, and an install runs the
            // package's own lifecycle scripts - which would inherit this pod's GitHub key, model keys, database
            // URL and IRSA role. `--ignore-scripts` blocks that hook, and `--` stops a "package" that starts
            // with a dash from being parsed as an npm flag.
            if (input.packages != null && input.packages.length > 0) {
                const installEnv = { PATH: process.env.PATH, HOME: process.env.HOME };
                const args = ["install", "--no-save", "--ignore-scripts", "--", ...input.packages];
                await this.runProcess("npm", args, workDir, installEnv);
            }
            // Inject the PREVIEW's env (so the script hits the same backend the test did); keep only PATH/HOME
            // from the worker so node resolves - do NOT leak the worker's own credentials into the script.
            const scriptEnv = { PATH: process.env.PATH, HOME: process.env.HOME, ...previewEnv };
            const output = await this.runProcess("node", ["index.mjs"], workDir, scriptEnv);
            return this.noteConnectionGaps(previewEnv) + output;
        } finally {
            await rm(workDir, { recursive: true, force: true }).catch((error) =>
                this.logger.warn("Failed to clean up script dir", { extra: { workDir }, err: error }),
            );
        }
    }

    /**
     * A header naming the vars whose value here is NOT the value the preview pod ran with.
     *
     * The script is given the app's secret bundle; the pod also received this PR's connections, which win on
     * collision and are templated per-PR (an ephemeral database host, a sibling service URL). So a colliding
     * key points the script at a DIFFERENT backend than the test used, and a connection-only key is simply
     * absent here. Either turns "the record is missing" into a fabricated fact, which is exactly the claim
     * this tool exists to make - so it is stated up front rather than left for the model to discover.
     */
    private noteConnectionGaps(previewEnv: Record<string, string>): string {
        const overridden = this.connectionKeys.filter((key) => key in previewEnv);
        const absent = this.connectionKeys.filter((key) => !(key in previewEnv));
        if (overridden.length === 0 && absent.length === 0) return "";

        const lines = ["[Environment caveat for this script - read before trusting a negative result:"];
        if (overridden.length > 0) {
            lines.push(
                `  ${overridden.join(", ")} - the preview pod OVERRODE these with per-PR connection values, so the value this script received points somewhere else. A "not found" here is NOT evidence the app's data is missing.`,
            );
        }
        if (absent.length > 0) {
            lines.push(
                `  ${absent.join(", ")} - supplied to the pod by a per-PR connection and NOT available here, so anything depending on them will fail to connect.`,
            );
        }
        lines.push("]");
        return `${lines.join("\n")}\n\n`;
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
