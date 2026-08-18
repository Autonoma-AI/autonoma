import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { trySpawn } from "../../src/core/try-spawn";

/**
 * A cwd that exists but is not a directory. Real cross-spawn, real Node, and an errno
 * off Node's deferred list (ENOTDIR), so this exercises the same throwing path that
 * reaches Windows users as EPERM - on any platform, without one.
 */
async function cwdThatIsAFile(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "try-spawn-"));
    const file = join(dir, "not-a-directory");
    await writeFile(file, "");
    return file;
}

describe("trySpawn", () => {
    test("a spawn failure Node throws instead of emitting comes back as a value", async () => {
        const cwd = await cwdThatIsAFile();

        const attempt = trySpawn("echo", ["hi"], { cwd });

        expect(attempt.started).toBe(false);
    });

    // The whole point of catching it: an `error` listener on the return value cannot
    // see this failure, because there is no return value to attach one to.
    test("the same failure escapes an error listener, which is why it needed catching", async () => {
        const cwd = await cwdThatIsAFile();
        const { default: spawn } = await import("cross-spawn");

        expect(() => spawn("echo", ["hi"], { cwd })).toThrow(/ENOTDIR/);
    });

    // Node names the binary only on the path that emits; the throwing path does not,
    // and an unnamed errno matches none of the "could not be run" patterns downstream.
    test("names the binary the throwing path leaves out", async () => {
        const cwd = await cwdThatIsAFile();

        const attempt = trySpawn("echo", ["hi"], { cwd });

        expect(attempt.started).toBe(false);
        if (attempt.started) return;
        expect(attempt.error.message).toBe("spawn echo ENOTDIR");
        expect(attempt.error.cause).toBeInstanceOf(Error);
    });

    test("a spawn that starts hands back the process untouched", () => {
        const attempt = trySpawn("node", ["--version"], { stdio: "ignore" });

        expect(attempt.started).toBe(true);
        if (!attempt.started) return;
        attempt.proc.kill("SIGKILL");
    });
});
