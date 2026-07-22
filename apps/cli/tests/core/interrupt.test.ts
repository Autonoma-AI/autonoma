import { describe, expect, test, beforeEach, afterEach, vi, type MockInstance } from "vitest";

// interrupt.ts keeps module-level state (installed/armed/quitting) and registers
// a process SIGINT listener, so each test loads a fresh copy via resetModules.
async function loadFresh() {
    vi.resetModules();
    return import("../../src/core/interrupt");
}

describe("interrupt handler", () => {
    let exitSpy: MockInstance;
    let stderrSpy: MockInstance;
    const sigintListeners: Array<(...args: unknown[]) => void> = [];

    beforeEach(() => {
        // process.exit must never actually kill the test runner.
        exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
            throw new Error(`__exit__:${code}`);
        }) as never);
        stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        vi.useFakeTimers();
    });

    afterEach(() => {
        for (const l of sigintListeners) process.removeListener("SIGINT", l);
        sigintListeners.length = 0;
        exitSpy.mockRestore();
        stderrSpy.mockRestore();
        vi.useRealTimers();
    });

    function captureSigint() {
        const before = process.listeners("SIGINT");
        return () => {
            const handler = process.listeners("SIGINT").find((l) => !before.includes(l)) as
                | ((...a: unknown[]) => void)
                | undefined;
            if (handler) sigintListeners.push(handler);
            return handler;
        };
    }

    test("first press arms (no exit), second press triggers graceful onExit once", async () => {
        const findHandler = captureSigint();
        const { installInterruptHandler } = await loadFresh();
        const onExit = vi.fn();
        installInterruptHandler({ onExit });
        const sigint = findHandler()!;

        sigint(); // first press: arm + hint
        expect(onExit).not.toHaveBeenCalled();
        expect(exitSpy).not.toHaveBeenCalled();

        sigint(); // second press within window: graceful exit
        expect(onExit).toHaveBeenCalledTimes(1);
    });

    test("a press after graceful exit started force-quits synchronously", async () => {
        const findHandler = captureSigint();
        const { installInterruptHandler } = await loadFresh();
        // onExit deliberately never calls process.exit, simulating a stalled flush.
        const onExit = vi.fn();
        installInterruptHandler({ onExit });
        const sigint = findHandler()!;

        sigint(); // arm
        sigint(); // graceful exit underway (quitting = true)
        expect(exitSpy).not.toHaveBeenCalled();

        // The user, still trapped, presses again - must escape immediately.
        expect(() => sigint()).toThrow("__exit__:130");
    });

    test("failsafe timer force-quits if graceful exit never lands process.exit", async () => {
        const findHandler = captureSigint();
        const { installInterruptHandler } = await loadFresh();
        const onExit = vi.fn(); // never exits
        installInterruptHandler({ onExit });
        const sigint = findHandler()!;

        sigint(); // arm
        sigint(); // graceful exit underway; failsafe timer scheduled

        expect(exitSpy).not.toHaveBeenCalled();
        expect(() => vi.advanceTimersByTime(2500)).toThrow("__exit__:130");
    });

    test("suspend detaches the SIGINT handler; resume re-attaches it", async () => {
        const findHandler = captureSigint();
        const { installInterruptHandler, suspend, resume } = await loadFresh();
        installInterruptHandler({ onExit: vi.fn() });
        const handler = findHandler()!;

        // Installed: the handler is on the process so Ctrl+C is intercepted.
        expect(process.listeners("SIGINT")).toContain(handler);

        // Suspended: detached so a spawned child owns Ctrl+C, not the CLI.
        suspend();
        expect(process.listeners("SIGINT")).not.toContain(handler);

        // Resumed: re-armed for when control returns to the CLI.
        resume();
        expect(process.listeners("SIGINT")).toContain(handler);
    });

    test("resume does not double-register the SIGINT handler", async () => {
        const findHandler = captureSigint();
        const { installInterruptHandler, resume } = await loadFresh();
        installInterruptHandler({ onExit: vi.fn() });
        const handler = findHandler()!;

        resume();
        resume();
        const count = process.listeners("SIGINT").filter((l) => l === handler).length;
        expect(count).toBe(1);
    });
});
