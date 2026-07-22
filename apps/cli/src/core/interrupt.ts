import { debugLog } from "./debug";
import { pauseUi, resumeUi, teardownUi } from "./ui-lifecycle";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const SHOW_CURSOR = "\x1b[?25h";

const EXIT_HINT = `${DIM}(press Ctrl+C again to exit)${RESET}`;
const ARM_WINDOW_MS = 3000;
// If the graceful exit (analytics flush -> process.exit) hasn't terminated the
// process within this window, bail unconditionally. onExit defers the real
// process.exit behind an async flush; if that chain ever fails to resolve, this
// is what guarantees the CLI still closes on a plain double-tap.
const FORCE_EXIT_MS = 2500;

let installed = false;
let armed = false;
let armTimer: ReturnType<typeof setTimeout> | undefined;
let onExit: ((exitCode?: number) => void) | undefined;
let quitting = false;

// While the Ink TUI is mounted, the arm hint must render inside the frame
// instead of scribbling on stderr. The TUI registers a display callback; when
// unset, the hint falls back to a plain stderr line.
let armDisplay: ((armed: boolean) => void) | undefined;

export function setInterruptArmDisplay(cb: ((armed: boolean) => void) | undefined): void {
    armDisplay = cb;
}

function showArmed(isArmed: boolean): void {
    if (armDisplay != null) {
        armDisplay(isArmed);
        return;
    }
    if (isArmed) process.stderr.write(`\n${EXIT_HINT}\n`);
}

function disarm(): void {
    if (armTimer) clearTimeout(armTimer);
    armTimer = undefined;
    armed = false;
    showArmed(false);
}

/** Last-resort synchronous exit. Never waits on a promise or the event loop. */
function forceExit(): void {
    restoreTerminal();
    // 130 = 128 + SIGINT, the conventional code for "terminated by Ctrl+C".
    process.exit(130);
}

function handleInterrupt(): void {
    // A graceful exit is already underway. Don't just swallow the signal - if the
    // async flush in onExit stalled, the user is now stuck with no way out. Treat
    // any further press as "get me out NOW" and exit synchronously, bypassing the
    // flush entirely.
    if (quitting) {
        forceExit();
        return;
    }

    if (armed) {
        quitting = true;
        disarm();
        // Failsafe: onExit hands off the real exit to an async analytics flush. If
        // that never lands process.exit, force it. unref so the timer itself can't
        // keep the process alive past a clean exit.
        setTimeout(forceExit, FORCE_EXIT_MS).unref?.();
        onExit?.();
        return;
    }
    // First press: arm a short window and tell the user how to actually exit.
    // Claude Code-style: a second Ctrl+C within the window quits; otherwise it
    // disarms and the run continues untouched.
    armed = true;
    showArmed(true);
    armTimer = setTimeout(disarm, ARM_WINDOW_MS);
}

/**
 * Feed a Ctrl+C press from the Ink TUI (mounted with exitOnCtrlC: false, so
 * raw-mode presses arrive as input, never as SIGINT). Applies the exact same
 * double-press policy as the signal path.
 */
export function interruptPress(): void {
    handleInterrupt();
}

/**
 * Install Ctrl+C double-press handling.
 *
 * Ctrl+C requires two presses within a 3s window to quit. The first press
 * shows a hint; if no second press lands, the run continues. While the Ink
 * TUI owns stdin (raw mode) presses arrive via interruptPress(); everywhere
 * else Ctrl+C arrives as a normal process SIGINT.
 */
export function installInterruptHandler(opts: { onExit: (exitCode?: number) => void }): void {
    onExit = opts.onExit;
    if (installed) return;
    installed = true;

    process.on("SIGINT", handleInterrupt);
}

/**
 * Hand the terminal to a spawned interactive child (e.g. a local agent).
 * Unmounts the TUI, detaches the CLI's SIGINT double-tap handler, and restores
 * cooked mode, so Ctrl+C behaves the way the developer expects INSIDE the
 * child - interrupting it, not killing the whole CLI. Idempotent; a no-op if
 * the handler was never installed.
 */
export function suspend(): void {
    if (!installed) return;
    // The Ink frame must be gone before the child owns the terminal.
    pauseUi();
    disarm();
    process.removeListener("SIGINT", handleInterrupt);
    restoreTerminal();
}

/** Re-arm the CLI's Ctrl+C handling after a suspended child exits. Idempotent. */
export function resume(): void {
    if (!installed) return;
    if (!process.listeners("SIGINT").includes(handleInterrupt)) {
        process.on("SIGINT", handleInterrupt);
    }
    resumeUi();
}

/**
 * Surface *why* the process ends when it isn't a clean Ctrl+C: an external
 * SIGTERM/SIGHUP (a task reaper, a parent shell going away, an OOM-adjacent kill),
 * or a crash from an unhandled exception/rejection that would otherwise die with no
 * breadcrumb. Each writes one greppable `[diagnostics]` line - including memory stats,
 * which hint at pressure-related kills - before letting the process go. SIGKILL cannot
 * be caught and leaves no trace by design; if a run vanishes with none of these lines,
 * it was SIGKILL (or the host pulled the whole environment).
 */
export function installTerminationDiagnostics(): void {
    const memSnapshot = (): string => {
        const m = process.memoryUsage();
        const mb = (n: number): number => Math.round(n / 1024 / 1024);
        return `rss=${mb(m.rss)}MB heapUsed=${mb(m.heapUsed)}MB heapTotal=${mb(m.heapTotal)}MB`;
    };

    for (const signal of ["SIGTERM", "SIGHUP"] as const) {
        // 128 + signal number (SIGTERM=15, SIGHUP=1), the conventional exit codes.
        const forcedCode = signal === "SIGTERM" ? 143 : 129;
        process.on(signal, () => {
            process.stderr.write(`\n[diagnostics] received ${signal} - external termination (${memSnapshot()})\n`);
            terminateGracefully(forcedCode);
        });
    }

    process.on("uncaughtException", (err) => {
        teardownUi();
        const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
        process.stderr.write(`\n[diagnostics] uncaughtException (${memSnapshot()}): ${detail}\n`);
        restoreTerminal();
        process.exit(1);
    });

    // An unhandled rejection is an un-awaited promise that failed - a real bug. Node's default
    // is to terminate the process; a listener that only logged would silently override that and
    // let the pipeline continue in a corrupted state (emitting a bad plan/factory from a
    // half-finished step). Surface the breadcrumb, then honor the crash instead of swallowing it.
    process.on("unhandledRejection", (reason) => {
        teardownUi();
        const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
        process.stderr.write(`\n[diagnostics] unhandledRejection (${memSnapshot()}): ${detail}\n`);
        restoreTerminal();
        process.exit(1);
    });
}

/**
 * Terminate in response to an external signal, but let the graceful shutdown hook run first so
 * buffered analytics are flushed and the resume hint is printed. The hook is handed `forcedCode`
 * so its own exit carries the conventional signal code (143/129) instead of a clean 0 - otherwise
 * a reaper/CI reading the exit code couldn't tell an external kill from normal completion. A
 * FORCE_EXIT_MS failsafe guarantees the process still closes with that code if the async flush
 * ever stalls; with no hook wired (or a graceful exit already in flight) we exit immediately.
 */
function terminateGracefully(forcedCode: number): void {
    if (quitting || onExit == null) {
        restoreTerminal();
        process.exit(forcedCode);
    }
    quitting = true;
    setTimeout(() => {
        restoreTerminal();
        process.exit(forcedCode);
    }, FORCE_EXIT_MS).unref?.();
    onExit(forcedCode);
}

/** Best-effort terminal restore before an abrupt exit. */
export function restoreTerminal(): void {
    try {
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
    } catch (err) {
        debugLog("Could not restore terminal raw mode", { err });
    }
    process.stdout.write(SHOW_CURSOR);
}
