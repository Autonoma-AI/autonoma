import { arch, cpus, platform, release, totalmem } from "node:os";
import { basename } from "node:path";
import { readEnv } from "../env";
import { isSpawnedByPlanner } from "./agent-env";

/**
 * The host facts every event should carry. Runs fail in ways that depend on the
 * machine rather than the code - a terminal that is not a TTY, an editor's
 * embedded shell, a constrained container - and without these a report is just
 * "it stopped", with no way to tell one user's environment from another's.
 *
 * Static for the life of the process, so it is computed once. Anything that
 * changes as the run proceeds (free memory, RSS) belongs on the individual
 * event, not here.
 */
export interface RuntimeContext {
    platform: string;
    arch: string;
    os_release: string;
    cpu_count: number;
    memory_total_mb: number;
    /** Both halves matter: a piped stdin with a TTY stdout behaves differently again. */
    is_tty_stdin: boolean;
    is_tty_stdout: boolean;
    term?: string;
    /** iTerm.app, vscode, cursor, Apple_Terminal - which terminal emulator is hosting us. */
    term_program?: string;
    shell?: string;
    columns?: number;
    rows?: number;
    is_ci: boolean;
    /** This planner run was itself started by an agent the planner spawned. */
    spawned_by_planner: boolean;
    /**
     * How the run was started. Splits what used to be a single ambiguous signal:
     * a missing `generation_id` meant standalone use, a dropped generation id, and
     * CI all at once, so a broken app -> CLI handoff was indistinguishable from
     * somebody running `npx @autonoma-ai/planner` in their own repo.
     *
     * Deliberately independent of `generation_id`, which is the point - it makes
     * "a front-door run with no generation id" an expressible query, and the
     * correct answer to it is always zero. Orthogonal to `is_ci`: a front-door run
     * can happen in CI, so collapsing them would lose that.
     */
    run_source: RunSource;
}

/**
 * `front_door` is inferred from `AUTONOMA_APPLICATION_ID`, which only the app's
 * generated command supplies. It cannot detect a run that lost its *entire* environment - that one
 * is indistinguishable from standalone use by construction - but it does catch a
 * command that arrived with its other variables and no usable generation id.
 */
export type RunSource = "front_door" | "standalone" | "unknown";

let cached: RuntimeContext | undefined;

/**
 * Never throws. This runs inside `track()`, which fires from the exit handler and
 * from catch blocks, so a diagnostic that can raise would turn telemetry into a
 * cause of failure - and would do it precisely on the paths that exist to report
 * a failure. On any surprise it degrades to the two facts that cannot fail.
 */
export function getRuntimeContext(): RuntimeContext {
    if (cached != null) return cached;
    try {
        cached = collect();
    } catch {
        cached = {
            platform: process.platform,
            arch: process.arch,
            os_release: "",
            cpu_count: 0,
            memory_total_mb: 0,
            is_tty_stdin: false,
            is_tty_stdout: false,
            is_ci: false,
            spawned_by_planner: false,
            // Unknown, not guessed: defaulting to "standalone" here would drop a
            // front-door run into the one bucket whose value is that it stays empty.
            run_source: "unknown",
        };
    }
    return cached;
}

function collect(): RuntimeContext {
    const env = process.env;
    const shell = env.SHELL;
    return {
        platform: platform(),
        arch: arch(),
        os_release: release(),
        // Documented to be empty on some platforms/containers rather than throwing.
        cpu_count: cpus().length,
        memory_total_mb: Math.round(totalmem() / 1024 / 1024),
        is_tty_stdin: process.stdin.isTTY === true,
        is_tty_stdout: process.stdout.isTTY === true,
        term: env.TERM,
        term_program: env.TERM_PROGRAM,
        // An empty SHELL is not a shell; basename("") would record "".
        shell: shell != null && shell !== "" ? basename(shell) : undefined,
        columns: process.stdout.columns,
        rows: process.stdout.rows,
        // Set by every major CI provider; a run with nobody watching explains a
        // stall that looks like a user walking away.
        is_ci: env.CI === "true" || env.CI === "1",
        spawned_by_planner: isSpawnedByPlanner(env),
        run_source: resolveRunSource(),
    };
}

function resolveRunSource(): RunSource {
    // AUTONOMA_APPLICATION_ID and nothing else. An API token is required for every
    // run, standalone included (see `ensureAutonomaAuth`), so treating it as an
    // app-launched signal would mark essentially every run `front_door` - and since
    // standalone runs legitimately have no generation id, the one query this exists
    // to answer would fire on all of them.
    const applicationId = readEnv().AUTONOMA_APPLICATION_ID;
    return applicationId != null && applicationId.trim() !== "" ? "front_door" : "standalone";
}
