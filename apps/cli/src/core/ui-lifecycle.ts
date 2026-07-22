import { debugLog } from "./debug";

/**
 * Registry decoupling the TUI's mount/unmount from the code that needs to
 * yield the terminal (the coding-agent handoff). The TUI
 * registers pause/resume at mount; core code calls pauseUi()/resumeUi()
 * without importing Ink. Headless runs never register, so both are no-ops.
 *
 * Pauses nest: only the 0 -> 1 transition pauses and the 1 -> 0 transition
 * resumes, so a suspend() inside an already-paused prompt is safe.
 */
export interface UiLifecycle {
    pause(): void;
    resume(): void;
}

let lifecycle: UiLifecycle | undefined;
let pauseDepth = 0;

export function registerUiLifecycle(l: UiLifecycle | undefined): void {
    lifecycle = l;
    pauseDepth = 0;
}

export function isUiActive(): boolean {
    return lifecycle != null;
}

export function pauseUi(): void {
    if (lifecycle == null) return;
    pauseDepth++;
    if (pauseDepth === 1) lifecycle.pause();
}

export function resumeUi(): void {
    if (lifecycle == null) return;
    if (pauseDepth === 0) {
        debugLog("resumeUi called with no matching pauseUi");
        return;
    }
    pauseDepth--;
    if (pauseDepth === 0) lifecycle.resume();
}

/** Run `fn` with the TUI paused (terminal handed back to cooked output). */
export async function withUiPaused<T>(fn: () => Promise<T>): Promise<T> {
    pauseUi();
    try {
        return await fn();
    } finally {
        resumeUi();
    }
}

/* ------------------------------------------------------- emergency teardown -- */

let teardown: (() => void) | undefined;

/** Registered by the TUI at mount so fatal paths can kill the frame. */
export function registerUiTeardown(fn: (() => void) | undefined): void {
    teardown = fn;
}

/**
 * Tear the TUI down NOW - for fatal error paths about to print and exit.
 * Restores the real console so the error is actually visible instead of
 * vanishing into the unmounted frame's captured log. Idempotent; a no-op
 * when nothing is mounted.
 */
export function teardownUi(): void {
    const fn = teardown;
    teardown = undefined;
    fn?.();
}
