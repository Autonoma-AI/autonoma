import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { EVALS_ROOT } from "./paths";

/**
 * Run the real planner CLI as a subprocess (one --step, or the full pipeline),
 * against a project, with a private HOME so the output dir (`$HOME/.autonoma/<slug>/`)
 * is scoped to the run. This drives the exact product path
 * (`autonoma-planner run [--step <name>] --non-interactive`) rather than
 * reconstructing its config/context plumbing.
 */

const CLI_INDEX = resolve(EVALS_ROOT, "..", "src", "index.ts");
const REPO_ROOT = resolve(EVALS_ROOT, "..", "..", "..");
const GRACEFUL_KILL_MS = 10_000;

/** Prefer the workspace's own tsx binary; fall back to PATH resolution. */
function tsxBin(): string {
    const local = join(REPO_ROOT, "node_modules", ".bin", "tsx");
    return existsSync(local) ? local : "tsx";
}

export interface RunPlannerOpts {
    /** A single --step to run (e.g. "entityAudit"); omit to run the full pipeline. */
    step?: string;
    /** Scope the run to one frontend dir (passed to the project mapper). */
    frontend?: string;
    /** Backend dirs the frontend depends on. */
    backends?: string[];
    /** Label for the log file (the step name, or "full"). */
    label: string;
    /** The project the planner analyzes (the clean sandbox). */
    projectRoot: string;
    /** Private HOME; the output dir lands under `<home>/.autonoma/<slug>/`. */
    home: string;
    /** Fixed output-dir slug (passed as --slug) so the seeded dir is deterministic. */
    slug: string;
    /** Autonoma API token - the planner runs its models through the managed proxy. */
    apiToken: string;
    /** Optional API host override. */
    apiUrl?: string;
    /** Optional planner model id (OpenRouter-style). */
    model?: string;
    /** Where to write the captured step log. */
    runDir: string;
    /** Wall-clock cap in ms; <= 0 means run until exit. */
    timeoutMs: number;
}

export interface RunPlannerResult {
    exitCode: number | undefined;
    timedOut: boolean;
    logPath: string;
    durationMs: number;
}

export async function runPlanner(opts: RunPlannerOpts): Promise<RunPlannerResult> {
    mkdirSync(opts.runDir, { recursive: true });
    const logPath = join(opts.runDir, `planner-${opts.label}.log`);
    const logStream = createWriteStream(logPath);

    const args = [
        CLI_INDEX,
        "run",
        "--project",
        opts.projectRoot,
        "--slug",
        opts.slug,
        "--non-interactive",
        ...(opts.step != null ? ["--step", opts.step] : []),
        ...(opts.frontend != null ? ["--frontend", opts.frontend] : []),
        ...(opts.backends != null && opts.backends.length > 0 ? ["--backends", opts.backends.join(",")] : []),
        ...(opts.model != null ? ["--model", opts.model] : []),
    ];

    const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: opts.home,
        LANG: process.env.LANG ?? "en_US.UTF-8",
        AUTONOMA_API_TOKEN: opts.apiToken,
        ...(opts.apiUrl != null ? { AUTONOMA_API_URL: opts.apiUrl } : {}),
    };

    const start = Date.now();
    const child = spawn(tsxBin(), args, {
        cwd: opts.projectRoot,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (c: Buffer) => {
        logStream.write(c);
        process.stdout.write(c);
    });
    child.stderr.on("data", (c: Buffer) => logStream.write(c));

    let timedOut = false;
    const timer =
        opts.timeoutMs > 0
            ? setTimeout(() => {
                  timedOut = true;
                  killTree(child.pid, "SIGTERM");
                  setTimeout(() => killTree(child.pid, "SIGKILL"), GRACEFUL_KILL_MS);
              }, opts.timeoutMs)
            : undefined;

    const exitCode = await new Promise<number | undefined>((res) =>
        child.on("close", (code) => res(code ?? undefined)),
    );
    if (timer != null) clearTimeout(timer);
    logStream.end();

    return { exitCode, timedOut, logPath, durationMs: Date.now() - start };
}

function killTree(pid: number | undefined, signal: NodeJS.Signals): void {
    if (pid == null) return;
    try {
        process.kill(-pid, signal);
    } catch (err) {
        console.error(`[planner-step] failed to ${signal} process group ${pid}`, err);
    }
}
