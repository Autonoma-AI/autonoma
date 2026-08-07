import { beforeEach, describe, expect, test, vi } from "vitest";
import type { PermissionMode } from "../../src/core/coding-agent";

/** The shape the autonomy question is asked in, so the recorded call needs no cast to read. */
interface AutonomyPrompt {
    message: string;
    options: { value: PermissionMode; label: string }[];
    initialValue: PermissionMode;
}

const CANCEL = Symbol("cancel");
const selectMock = vi.fn<(prompt: AutonomyPrompt) => Promise<PermissionMode | typeof CANCEL>>();

vi.mock("../../src/ui/prompts", () => ({
    select: (prompt: AutonomyPrompt) => selectMock(prompt),
    isCancel: (v: unknown) => v === CANCEL,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/**
 * The answer is scoped to the run, i.e. to the process - so each test needs a
 * fresh module instance to stand for a fresh run. A shared static import would
 * carry the first test's answer into every test after it.
 */
async function freshRun() {
    vi.resetModules();
    const { resolvePermissionMode } = await import("../../src/core/permission-mode");
    return resolvePermissionMode;
}

beforeEach(() => {
    selectMock.mockReset();
});

describe("resolvePermissionMode", () => {
    /**
     * The reported bug: a single run hands the terminal to a coding agent up to
     * three times - preview, recipe handoff, SDK repair - and asked about autonomy
     * at every one of them.
     */
    test("asks once and reuses the answer for the rest of the run", async () => {
        const resolve = await freshRun();
        selectMock.mockResolvedValue("acceptEdits");

        const preview = await resolve({ interactive: true });
        const handoff = await resolve({ interactive: true });
        const sdkRepair = await resolve({ interactive: true });

        expect([preview, handoff, sdkRepair]).toEqual(["acceptEdits", "acceptEdits", "acceptEdits"]);
        expect(selectMock).toHaveBeenCalledTimes(1);
    });

    test("never asks when --permission-mode answered it", async () => {
        const resolve = await freshRun();

        expect(await resolve({ preset: "default", interactive: true })).toBe("default");
        expect(await resolve({ interactive: true })).toBe("default");
        expect(selectMock).not.toHaveBeenCalled();
    });

    /** The flag is the most explicit input there is, so it outranks a resumed run's record. */
    test("lets the flag override what a resumed run remembered", async () => {
        const resolve = await freshRun();

        expect(await resolve({ preset: "default", remembered: "bypassPermissions", interactive: true })).toBe(
            "default",
        );
        expect(selectMock).not.toHaveBeenCalled();
    });

    /** Continuing a run is not a new decision - the recorded answer stands. */
    test("does not re-ask a resumed run that already recorded an answer", async () => {
        const resolve = await freshRun();

        expect(await resolve({ remembered: "acceptEdits", interactive: true })).toBe("acceptEdits");
        expect(selectMock).not.toHaveBeenCalled();
    });

    test("defaults to fully autonomous headless, where there is nobody to ask", async () => {
        const resolve = await freshRun();

        expect(await resolve({ interactive: false })).toBe("bypassPermissions");
        expect(selectMock).not.toHaveBeenCalled();
    });

    test("offers fully autonomous as the highlighted choice", async () => {
        const resolve = await freshRun();
        selectMock.mockResolvedValue("bypassPermissions");

        await resolve({ interactive: true });

        expect(selectMock.mock.calls[0]?.[0].initialValue).toBe("bypassPermissions");
    });

    test("treats a cancelled prompt as an aborted run, not as a silent default", async () => {
        const resolve = await freshRun();
        selectMock.mockResolvedValue(CANCEL);

        await expect(resolve({ interactive: true })).rejects.toThrow("Permission mode selection cancelled");
    });
});
