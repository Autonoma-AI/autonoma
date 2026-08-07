import type { KillableProcess } from "../../core/coding-agent";
import { debugLog } from "../../core/debug";
import { readCompletion } from "./completion";

/** How often to check for the completion marker while the agent runs. */
const MARKER_POLL_MS = 2000;
/** Marker seen -> let the agent finish streaming its summary before reclaiming. */
const MARKER_EXIT_GRACE_MS = 30_000;
/** SIGTERM ignored -> force-kill after this long. */
const KILL_ESCALATION_MS = 10_000;

export interface CompletionWatchTiming {
    pollMs: number;
    graceMs: number;
    killMs: number;
}

const DEFAULT_WATCH_TIMING: CompletionWatchTiming = {
    pollMs: MARKER_POLL_MS,
    graceMs: MARKER_EXIT_GRACE_MS,
    killMs: KILL_ESCALATION_MS,
};

/**
 * Poll for the completion marker while the interactive agent runs; once it
 * appears, give the agent a beat to finish streaming its summary, then
 * terminate it so control returns to the planner. Returns a cleanup fn.
 *
 * This is the SDK handoff's own notion of "done", which is why it lives here and is
 * handed to the launcher rather than built into it: an interactive session never
 * exits on its own, and what counts as finished differs per handoff.
 */
export function watchForCompletion(
    outputDir: string,
    proc: KillableProcess,
    timing: CompletionWatchTiming = DEFAULT_WATCH_TIMING,
): () => void {
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const poll = setInterval(() => {
        void readCompletion(outputDir).then((complete) => {
            // A read in flight when cleanup ran outlives it, and would otherwise arm the reclaim afterwards -
            // signalling a process that has already exited, and holding the event loop open for the grace plus
            // escalation window. Clearing the timers cannot cover it: there is nothing to clear yet.
            if (stopped || !complete || graceTimer != null) return;
            debugLog("Completion marker detected while the agent runs; scheduling terminal reclaim");
            clearInterval(poll);
            graceTimer = setTimeout(() => {
                debugLog("Reclaiming the terminal from the interactive agent (SIGTERM)");
                proc.kill("SIGTERM");
                killTimer = setTimeout(() => {
                    debugLog("Agent ignored SIGTERM; escalating to SIGKILL");
                    proc.kill("SIGKILL");
                }, timing.killMs);
            }, timing.graceMs);
        });
    }, timing.pollMs);

    return () => {
        stopped = true;
        clearInterval(poll);
        if (graceTimer != null) clearTimeout(graceTimer);
        if (killTimer != null) clearTimeout(killTimer);
    };
}
