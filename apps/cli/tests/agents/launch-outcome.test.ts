import { describe, expect, test } from "vitest";
import { type AgentLaunch, describeLaunchOutcome } from "../../src/agents/04-recipe-builder/launch-outcome";

function launch(overrides: Partial<AgentLaunch> = {}): AgentLaunch {
    return { agentLabel: "Claude Code", agentId: "claude", exitCode: 0, durationMs: 20 * 60_000, ...overrides };
}

describe("describeLaunchOutcome", () => {
    // Exit 143 is the completion watcher terminating an agent that finished: the most
    // common shape of a SUCCESSFUL run, and never a failure to start.
    test("a long session is treated as having run, whatever it exited with", () => {
        expect(describeLaunchOutcome(launch({ exitCode: 143 })).kind).toBe("ran");
        expect(describeLaunchOutcome(launch({ exitCode: 1 })).kind).toBe("ran");
        expect(describeLaunchOutcome(launch({ exitCode: undefined })).kind).toBe("ran");
    });

    // The observed shape: two launches, exit 1, 358ms between them for both.
    test("an instant non-zero exit is a failure to start", () => {
        const outcome = describeLaunchOutcome(launch({ exitCode: 1, durationMs: 324 }));

        expect(outcome.kind).toBe("failed-to-start");
        if (outcome.kind !== "failed-to-start") return;
        expect(outcome.summary).toMatch(/Claude Code exited immediately \(code 1/);
    });

    // A short CLEAN exit is an agent that started and gave up, not one that never ran -
    // that is worth another attempt with a diagnosis, which is a different decision.
    test("a short clean exit is a session that ran", () => {
        expect(describeLaunchOutcome(launch({ exitCode: 0, durationMs: 29_000 })).kind).toBe("ran");
    });

    // An absent exit code is what a signalled agent reports too - most often the
    // completion watcher terminating one that finished - so on its own it says nothing.
    // `started` is the field that separates the two, exercised below.
    test("an unknown exit code is not read as a failure to start", () => {
        expect(describeLaunchOutcome(launch({ exitCode: undefined, durationMs: 100 })).kind).toBe("ran");
    });

    // A machine that refuses to execute the binary produces no process and no code. It
    // has to reach the same branch an instant bad exit does, because the recovery there
    // is to move to a different agent - the one thing that can still work.
    test("a launch that never produced a process is a failure to start", () => {
        const outcome = describeLaunchOutcome(launch({ started: false, exitCode: undefined, durationMs: 4 }));

        expect(outcome.kind).toBe("failed-to-start");
        if (outcome.kind !== "failed-to-start") return;
        expect(outcome.summary).toMatch(/Claude Code could not be started on this machine/);
    });

    // The timing heuristic exists to guess whether work happened. Nothing to guess here.
    test("a launch that never started stays one however long it took to find out", () => {
        const slow = launch({ started: false, exitCode: undefined, durationMs: 20 * 60_000 });

        expect(describeLaunchOutcome(slow).kind).toBe("failed-to-start");
    });

    // Written before `started` existed, and read back by `--resume`. Every launch that
    // got as far as being recorded then had started, so absent must keep meaning that -
    // this is the never-started record with only that field removed, and it must flip.
    test("state persisted without the field still reads as a session that ran", () => {
        const legacy: AgentLaunch = {
            agentLabel: "Claude Code",
            agentId: "claude",
            exitCode: undefined,
            durationMs: 4,
        };

        expect(describeLaunchOutcome(legacy).kind).toBe("ran");
    });
});

/**
 * Every real launch observed over three weeks of production runs, as (exit code,
 * seconds). The threshold is only worth anything if it separates these correctly, and
 * the separation is not obvious from the code alone - so the corpus is pinned here.
 *
 * Non-zero exits fall into two clusters with a wide gap between them: thirteen at 59s
 * or under, then three at 106s and above. Nothing lands in between, which is what
 * makes a threshold viable at all. Both edges of that gap are load-bearing:
 *
 *  - Under it, every affected run exhausted BOTH of its attempts and none ever
 *    completed, so treating them as "never started" gives up nothing.
 *  - Over it, a launch that exited 1 after 133s was retried with the same agent and
 *    the retry SUCCEEDED. Classifying that one as a failure to start would have
 *    abandoned a run that worked, which is what rules out a threshold of a few
 *    minutes.
 */
const OBSERVED_LAUNCHES: ReadonlyArray<{ exitCode: number | undefined; seconds: number; expected: string }> = [
    // Failed to start: the agent binary never ran the integration.
    { exitCode: 1, seconds: 0, expected: "failed-to-start" },
    { exitCode: 1, seconds: 1, expected: "failed-to-start" },
    { exitCode: 1, seconds: 4, expected: "failed-to-start" },
    { exitCode: 1, seconds: 32, expected: "failed-to-start" },
    { exitCode: 1, seconds: 37, expected: "failed-to-start" },
    { exitCode: 1, seconds: 43, expected: "failed-to-start" },
    { exitCode: 1, seconds: 59, expected: "failed-to-start" },
    // Ran: non-zero, but far enough in to have done work. The 133s row is the one
    // whose retry went on to complete the integration.
    { exitCode: 1, seconds: 106, expected: "ran" },
    { exitCode: 1, seconds: 124, expected: "ran" },
    { exitCode: 1, seconds: 133, expected: "ran" },
    { exitCode: 129, seconds: 271, expected: "ran" },
    // Ran: a clean exit is never a failure to start, however brief.
    { exitCode: 0, seconds: 27, expected: "ran" },
    { exitCode: 0, seconds: 86, expected: "ran" },
    { exitCode: 0, seconds: 1845, expected: "ran" },
    // Ran: 143 is the completion watcher terminating a finished session - the single
    // most common shape of a SUCCESSFUL run.
    { exitCode: 143, seconds: 415, expected: "ran" },
    { exitCode: 143, seconds: 6652, expected: "ran" },
    // Ran: a Windows crash code after 70 minutes of real work.
    { exitCode: 3221225786, seconds: 4245, expected: "ran" },
    // Ran: no exit code at all, so nothing to classify on.
    { exitCode: undefined, seconds: 508, expected: "ran" },
];

describe("describeLaunchOutcome against observed production launches", () => {
    test.each(OBSERVED_LAUNCHES)("exit $exitCode after $seconds s -> $expected", ({ exitCode, seconds, expected }) => {
        expect(describeLaunchOutcome(launch({ exitCode, durationMs: seconds * 1000 })).kind).toBe(expected);
    });

    // The gap the threshold lives in. If a future edit moves it outside this range it
    // starts misreading real launches, so fail here rather than in production.
    test("the threshold sits inside the gap the two clusters leave", () => {
        const highestFailedToStart = Math.max(
            ...OBSERVED_LAUNCHES.filter((l) => l.expected === "failed-to-start").map((l) => l.seconds),
        );
        const lowestNonZeroThatRan = Math.min(
            ...OBSERVED_LAUNCHES.filter(
                (l) => l.expected === "ran" && l.exitCode != null && l.exitCode !== 0 && l.exitCode !== 143,
            ).map((l) => l.seconds),
        );

        expect(highestFailedToStart).toBeLessThan(lowestNonZeroThatRan);
        expect(describeLaunchOutcome(launch({ exitCode: 1, durationMs: highestFailedToStart * 1000 })).kind).toBe(
            "failed-to-start",
        );
        expect(describeLaunchOutcome(launch({ exitCode: 1, durationMs: lowestNonZeroThatRan * 1000 })).kind).toBe(
            "ran",
        );
    });
});
