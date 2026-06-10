import { execFileSync } from "node:child_process";
import { type Logger, logger as rootLogger } from "@autonoma/logger";

/** The binary + args + env to hand to `execFile` for one isolated command run. */
export interface SandboxSpec {
    file: string;
    args: string[];
    env: Record<string, string>;
}

/**
 * Result of probing for `bwrap` on this host, computed once and reused. `true`
 * once a `bwrap --version` succeeds; `false` once it fails (e.g. macOS / local
 * eval). We never re-probe within a process - the binary doesn't appear or
 * vanish mid-run.
 */
let cachedBwrapAvailable: boolean | undefined;

function detectBwrap(): boolean {
    if (cachedBwrapAvailable != null) return cachedBwrapAvailable;
    try {
        execFileSync("bwrap", ["--version"], { stdio: "ignore" });
        cachedBwrapAvailable = true;
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        rootLogger.debug("bwrap probe failed; treating process isolation as unavailable", { extra: { reason } });
        cachedBwrapAvailable = false;
    }
    return cachedBwrapAvailable;
}

/**
 * The durable security boundary for the {@link BashTool} child process. The
 * command allowlist is a first gate, not a boundary - several allowed verbs can
 * still write or execute within a single invocation (`find -exec`, `sed -i`,
 * `awk 'system()'`, `git` write subcommands). This wraps the child in
 * bubblewrap so that, regardless of the command, it cannot:
 *
 * - write or delete files (everything is bound read-only; only `/tmp` is a fresh tmpfs),
 * - reach the network (`--unshare-net` gives an empty network namespace),
 * - read host paths outside the clone (only the clone + minimal system dirs are bound),
 * - see worker secrets (`--clearenv` then re-set only the scrubbed passthrough vars).
 *
 * Cross-platform contract: when `bwrap` is absent (macOS / local eval) the
 * wrapper **no-ops** - it returns the bare `sh -c` invocation and logs a clear
 * degraded-isolation warning, so isolation is never *silently* off in
 * production.
 */
export class CommandSandbox {
    private readonly logger: Logger;
    private readonly bwrapAvailable: boolean;

    /**
     * `bwrapAvailable` is injectable for tests; in production it is probed once
     * via {@link detectBwrap} and cached.
     */
    constructor(bwrapAvailable: boolean = detectBwrap()) {
        this.bwrapAvailable = bwrapAvailable;
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    /** Whether commands handed to {@link wrap} will be process-isolated. */
    public get isolated(): boolean {
        return this.bwrapAvailable;
    }

    /**
     * Build the exec spec for `command`. When bubblewrap is available the child
     * is fully isolated; `cloneRoot` is bound read-only and becomes the working
     * directory. `baseEnv` is the already-scrubbed passthrough env (PATH / HOME /
     * LANG) - the only env the child ever sees.
     */
    public wrap(command: string, cloneRoot: string, baseEnv: Record<string, string>): SandboxSpec {
        if (!this.bwrapAvailable) {
            this.logger.warn(
                "bubblewrap (bwrap) not found - running the bash tool WITHOUT process isolation (degraded). " +
                    "The child can write files, reach the network, and read host paths outside the clone. " +
                    "This is expected on macOS / local eval, but in production it means isolation is off.",
            );
            return { file: "sh", args: ["-c", command], env: baseEnv };
        }

        const childEnv = withGitSafeDirectory(baseEnv, cloneRoot);
        const args = buildBwrapArgs(cloneRoot, childEnv, command);
        this.logger.debug("Isolating command with bubblewrap", { extra: { cloneRoot } });
        // `baseEnv` (with PATH) is what `execFile` uses to resolve the `bwrap`
        // binary itself; `--clearenv` + `--setenv` govern what the child sees.
        return { file: "bwrap", args, env: baseEnv };
    }
}

/**
 * git refuses to operate on a repo whose directory it considers "dubious
 * ownership". Rather than bind a host `.gitconfig` into the sandbox, inject the
 * clone as a trusted `safe.directory` through git's env-config protocol so the
 * sandbox stays self-contained.
 */
function withGitSafeDirectory(baseEnv: Record<string, string>, cloneRoot: string): Record<string, string> {
    const env: Record<string, string> = { ...baseEnv };
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "safe.directory";
    env.GIT_CONFIG_VALUE_0 = cloneRoot;
    return env;
}

/**
 * Assemble the bubblewrap arguments, ending in `sh -c <command>`. `-try` binds
 * tolerate a missing source path (e.g. `/lib64` on arm64, or usrmerge symlinks),
 * so the same arg set works across the worker's Debian image without erroring.
 */
function buildBwrapArgs(cloneRoot: string, childEnv: Record<string, string>, command: string): string[] {
    const args = [
        // Read-only system dirs so the allowed binaries (sh, git, rg, sed, awk, ...)
        // and the dynamic linker resolve. On usrmerge Debian, /bin /sbin /lib are
        // symlinks into /usr; binding them re-exposes the resolved targets.
        "--ro-bind",
        "/usr",
        "/usr",
        "--ro-bind-try",
        "/bin",
        "/bin",
        "--ro-bind-try",
        "/sbin",
        "/sbin",
        "--ro-bind-try",
        "/lib",
        "/lib",
        "--ro-bind-try",
        "/lib64",
        "/lib64",
        // Linker cache/config and Debian's update-alternatives symlinks (awk -> mawk).
        // Specific files only - NOT all of /etc - to honor "no host reads outside the clone".
        "--ro-bind-try",
        "/etc/ld.so.cache",
        "/etc/ld.so.cache",
        "--ro-bind-try",
        "/etc/ld.so.conf",
        "/etc/ld.so.conf",
        "--ro-bind-try",
        "/etc/ld.so.conf.d",
        "/etc/ld.so.conf.d",
        "--ro-bind-try",
        "/etc/alternatives",
        "/etc/alternatives",
        // Minimal /proc and /dev (null, zero, random, ...); /tmp is fresh scratch,
        // never the host's, so a command can write there but touches no host file.
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
        // The clone is the only host data exposed - read-only, at its real path -
        // and is the working directory.
        "--ro-bind",
        cloneRoot,
        cloneRoot,
        "--chdir",
        cloneRoot,
        // No network; no host PID/IPC/UTS visibility; die when the worker dies so
        // a timed-out command leaves no orphan.
        "--unshare-net",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        "--die-with-parent",
        "--new-session",
        // Drop every inherited var, then re-add only the scrubbed passthrough set.
        "--clearenv",
    ];
    for (const [key, value] of Object.entries(childEnv)) {
        args.push("--setenv", key, value);
    }
    args.push("sh", "-c", command);
    return args;
}
