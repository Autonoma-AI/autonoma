/**
 * Whether a coding agent's launch actually ran the integration, judged from the
 * outside - the exit code and how long it lasted.
 *
 * The phase deliberately decides success from the completion marker and the recipe
 * rather than the exit code, because an interactive session that finished the work
 * sits open afterwards and gets terminated. But that reasoning only holds for a
 * session that ran. It says nothing about one that never started, and conflating the
 * two is what let a broken agent binary be reported as a missing recipe file.
 */

/**
 * Under this, a non-zero exit means the agent never got to the work.
 *
 * Calibrated against every launch observed over three weeks, not picked round.
 * Non-zero exits fall into two clusters with nothing between them: thirteen at 59s or
 * under, then 106s, 124s and 133s. Any threshold in (59s, 106s] classifies all of
 * them identically, and both edges of that gap are load-bearing - under it, every
 * affected run spent both attempts and none ever completed, so calling them "never
 * started" gives up nothing; over it sits a launch that exited 1 at 133s whose retry
 * SUCCEEDED, which is what rules out a threshold of a few minutes. 90s takes the
 * middle so a slow machine has room before it reads as a failure to start.
 *
 * `tests/agents/launch-outcome.test.ts` pins that corpus and fails if an edit moves
 * this outside the gap.
 */
const FAILED_TO_START_MS = 90_000;

/** What one launch of a coding agent did, as observed from outside it. */
export interface AgentLaunch {
    /** Human label of the agent that ran, for the message this produces. */
    agentLabel: string;
    /** Stable id of that agent, so a retry can deliberately pick a different one. */
    agentId: string;
    exitCode: number | undefined;
    durationMs: number;
}

export type LaunchOutcome =
    /** The agent exited too fast and too badly to have done anything. */
    | { kind: "failed-to-start"; summary: string }
    /** The agent ran. Whether it finished the job is the recipe's question, not this one. */
    | { kind: "ran" };

export function describeLaunchOutcome(launch: AgentLaunch): LaunchOutcome {
    const ranTooBriefly = launch.durationMs < FAILED_TO_START_MS;
    const exitedBadly = launch.exitCode != null && launch.exitCode !== 0;
    if (!ranTooBriefly || !exitedBadly) return { kind: "ran" };

    return {
        kind: "failed-to-start",
        summary:
            `${launch.agentLabel} exited immediately (code ${launch.exitCode}, after ` +
            `${Math.round(launch.durationMs / 1000)}s) without running the integration. That is the agent ` +
            `itself failing to start, not the integration failing - check that it runs on its own in this ` +
            `terminal.`,
    };
}
