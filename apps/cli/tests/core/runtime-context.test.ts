import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The context is gathered inside `track()`, which fires from the exit handler and
 * from catch blocks. If gathering it could throw, telemetry would become a cause
 * of failure on exactly the paths that exist to report one - so "never throws"
 * is the property worth pinning, not the individual field values.
 */
const originalEnv = { ...process.env };

beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
});

afterEach(() => {
    vi.doUnmock("node:os");
    process.env = { ...originalEnv };
});

describe("getRuntimeContext", () => {
    test("degrades instead of throwing when the OS layer misbehaves", async () => {
        vi.doMock("node:os", () => ({
            platform: () => "linux",
            arch: () => "x64",
            release: () => "6.1.0",
            totalmem: () => 1024,
            cpus: () => {
                throw new Error("cpu info unavailable in this container");
            },
        }));

        const { getRuntimeContext } = await import("../../src/core/runtime-context");
        const context = getRuntimeContext();

        // The run must continue; a partial context beats a crashed report.
        expect(context.platform).toBeTruthy();
        expect(context.cpu_count).toBe(0);
    });

    test("a non-TTY run reports no terminal size rather than inventing one", async () => {
        const { getRuntimeContext } = await import("../../src/core/runtime-context");
        const context = getRuntimeContext();

        // Vitest runs without a TTY, so these are genuinely absent here.
        expect(context.is_tty_stdout).toBe(false);
        expect(context.columns ?? null).not.toBe(0);
    });

    test("an empty SHELL is reported as no shell, not as an empty name", async () => {
        vi.stubEnv("SHELL", "");
        const { getRuntimeContext } = await import("../../src/core/runtime-context");

        expect(getRuntimeContext().shell).toBeUndefined();
    });
});
