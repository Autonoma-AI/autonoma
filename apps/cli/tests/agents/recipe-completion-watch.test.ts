import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { COMPLETION_MARKER_FILE, readCompletion } from "../../src/agents/04-recipe-builder/completion";
import type * as CompletionModule from "../../src/agents/04-recipe-builder/completion";
import { watchForCompletion } from "../../src/agents/04-recipe-builder/completion-watch";

// Spied, not stubbed: every test but the last one wants the real marker read. The last one needs to choose
// when a read lands, which is the one thing a real fs read will not let it decide.
vi.mock("../../src/agents/04-recipe-builder/completion", async (importOriginal) => {
    const actual = await importOriginal<typeof CompletionModule>();
    return { ...actual, readCompletion: vi.fn(actual.readCompletion) };
});

describe("watchForCompletion", () => {
    const TIMING = { pollMs: 10, graceMs: 20, killMs: 5000 };
    let dir: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "watch-completion-"));
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    test("terminates the agent shortly after the completion marker appears", async () => {
        const kill = vi.fn((_signal: NodeJS.Signals) => true);
        const stop = watchForCompletion(dir, { kill }, TIMING);
        await writeFile(join(dir, COMPLETION_MARKER_FILE), JSON.stringify({ complete: true }), "utf-8");
        await vi.waitFor(() => expect(kill).toHaveBeenCalledWith("SIGTERM"), { timeout: 2000 });
        stop();
    });

    test("never kills while no valid marker exists", async () => {
        const kill = vi.fn((_signal: NodeJS.Signals) => true);
        const stop = watchForCompletion(dir, { kill }, TIMING);
        await writeFile(join(dir, COMPLETION_MARKER_FILE), JSON.stringify({ complete: false }), "utf-8");
        await new Promise((r) => setTimeout(r, 100));
        expect(kill).not.toHaveBeenCalled();
        stop();
    });

    test("cleanup stops a pending reclaim (the agent exited on its own)", async () => {
        const graceMs = 1000;
        vi.useFakeTimers();
        try {
            const kill = vi.fn((_signal: NodeJS.Signals) => true);
            const stop = watchForCompletion(dir, { kill }, { ...TIMING, graceMs });
            await writeFile(join(dir, COMPLETION_MARKER_FILE), JSON.stringify({ complete: true }), "utf-8");
            await vi.advanceTimersByTimeAsync(TIMING.pollMs * 20);
            stop();
            await vi.advanceTimersByTimeAsync(graceMs + TIMING.killMs);
            expect(kill).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    /**
     * The same cleanup, with the poll's read still in flight when it runs - which is what a loaded machine
     * produces, since fake timers do not fake the filesystem. Clearing the timers cannot cover this: the read
     * arms the reclaim when it lands, and at cleanup there is nothing scheduled yet to clear.
     */
    test("a poll that lands after cleanup cannot arm the reclaim", async () => {
        const graceMs = 1000;
        vi.useFakeTimers();
        try {
            let landRead: ((complete: boolean) => void) | undefined;
            vi.mocked(readCompletion).mockReturnValueOnce(
                new Promise<boolean>((resolve) => {
                    landRead = resolve;
                }),
            );
            const kill = vi.fn((_signal: NodeJS.Signals) => true);
            const stop = watchForCompletion(dir, { kill }, { ...TIMING, graceMs });

            await vi.advanceTimersByTimeAsync(TIMING.pollMs);
            stop();
            landRead?.(true);
            await vi.advanceTimersByTimeAsync(graceMs + TIMING.killMs);

            expect(kill).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });
});
