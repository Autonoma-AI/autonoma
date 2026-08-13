import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "@autonoma/logger";
import { describe, expect, it } from "vitest";
import { GitCommandError, isUnreachableRefError, runGitStep, toGitCommandError } from "./git-clone-step";

describe("toGitCommandError", () => {
    it("marks a timeout kill as timedOut and names the step", () => {
        // The shape `execFile` produces when its timeout fires: Node-killed with SIGTERM, no exit code.
        const raw = { killed: true, signal: "SIGTERM", code: null, stderr: "Cloning into '/tmp/x'...\n" };

        const error = toGitCommandError(raw, {
            step: "clone",
            subcommand: "clone",
            elapsedMs: 120_034,
            timeoutMs: 120_000,
            token: "",
        });

        expect(error).toBeInstanceOf(GitCommandError);
        expect(error.details.timedOut).toBe(true);
        expect(error.details.killed).toBe(true);
        expect(error.details.signal).toBe("SIGTERM");
        expect(error.details.step).toBe("clone");
        expect(error.details.elapsedMs).toBe(120_034);
        expect(error.details.exitCode).toBeUndefined();
        expect(error.message).toContain("timed out");
        expect(error.message).toContain("step=clone");
    });

    it("keeps a genuine git failure distinguishable from a timeout", () => {
        const raw = {
            killed: false,
            signal: null,
            code: 128,
            stderr: "fatal: remote error: upload-pack: not our ref f3a9c2aa\n",
        };

        const error = toGitCommandError(raw, {
            step: "fetch-base",
            subcommand: "fetch",
            elapsedMs: 829,
            timeoutMs: 60_000,
            token: "",
        });

        expect(error.details.timedOut).toBe(false);
        expect(error.details.killed).toBe(false);
        expect(error.details.exitCode).toBe(128);
        expect(error.message).toContain("step=fetch-base");
        expect(error.message).toContain("not our ref");
        expect(error.message).not.toContain("timed out");
    });

    it("distinguishes an external signal kill (e.g. the OOM killer) from our timeout", () => {
        // The OOM killer sends SIGKILL directly; Node did not send it, so `killed` is false.
        const raw = { killed: false, signal: "SIGKILL", code: null, stderr: "" };

        const error = toGitCommandError(raw, {
            step: "clone",
            subcommand: "clone",
            elapsedMs: 45_000,
            timeoutMs: 120_000,
            token: "",
        });

        expect(error.details.timedOut).toBe(false);
        expect(error.details.killed).toBe(true);
        expect(error.details.signal).toBe("SIGKILL");
        expect(error.message).toContain("killed by SIGKILL");
        expect(error.message).not.toContain("timed out");
    });

    it("redacts the installation token from the message and stderr", () => {
        const token = "ghs_SECRETTOKEN123";
        const raw = {
            killed: false,
            signal: null,
            code: 128,
            stderr: `fatal: could not read Username for 'https://${token}@github.com'\n`,
        };

        const error = toGitCommandError(raw, {
            step: "clone",
            subcommand: "clone",
            elapsedMs: 42,
            timeoutMs: 120_000,
            token,
        });

        expect(error.message).not.toContain(token);
        expect(error.message).toContain("***");
    });
});

describe("runGitStep", () => {
    it("captures a real timeout kill as a structured GitCommandError", async () => {
        // `git hash-object --stdin` blocks waiting for stdin EOF; with no stdin
        // provided our timeout kills it - a deterministic, offline timeout.
        const cwd = await mkdtemp(join(tmpdir(), "runstep-timeout-"));

        const error = await runGitStep(
            "clone",
            ["hash-object", "--stdin"],
            { timeoutMs: 500, cwd },
            "",
            logger.child({ name: "runGitStep.test" }),
        ).then(
            () => undefined,
            (err: unknown) => err,
        );

        expect(error).toBeInstanceOf(GitCommandError);
        if (!(error instanceof GitCommandError)) throw new Error("expected GitCommandError");
        expect(error.details.timedOut).toBe(true);
        expect(error.details.killed).toBe(true);
        expect(error.details.step).toBe("clone");
        expect(error.details.elapsedMs).toBeGreaterThanOrEqual(0);
    });

    it("captures a real non-timeout git failure with its exit code", async () => {
        // `cat-file` on a bad object outside a repo fails fast with exit 128.
        const cwd = await mkdtemp(join(tmpdir(), "runstep-fail-"));

        const error = await runGitStep(
            "cat-file-base",
            ["cat-file", "-t", "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"],
            { timeoutMs: 5_000, cwd },
            "",
            logger.child({ name: "runGitStep.test" }),
        ).then(
            () => undefined,
            (err: unknown) => err,
        );

        expect(error).toBeInstanceOf(GitCommandError);
        if (!(error instanceof GitCommandError)) throw new Error("expected GitCommandError");
        expect(error.details.timedOut).toBe(false);
        expect(error.details.step).toBe("cat-file-base");
        expect(error.details.exitCode).toBe(128);
    });
});

describe("isUnreachableRefError", () => {
    /** A `fetch-base` failure as `runGitStep` would translate it, from the raw `execFile` rejection shape. */
    function fetchBaseError(raw: { killed: boolean; signal: string | null; code: number | null; stderr: string }) {
        return toGitCommandError(raw, {
            step: "fetch-base",
            subcommand: "fetch",
            elapsedMs: 42,
            timeoutMs: 60_000,
            token: "",
        });
    }

    it("recovers a base the remote refuses to serve (not our ref)", () => {
        const error = fetchBaseError({
            killed: false,
            signal: null,
            code: 128,
            stderr: "fatal: remote error: upload-pack: not our ref f3a9c2aa989ae44c25fae9b8b8827bd6289ab65c\n",
        });
        expect(isUnreachableRefError(error)).toBe(true);
    });

    it("recovers a ref the remote never had (couldn't find remote ref)", () => {
        const error = fetchBaseError({
            killed: false,
            signal: null,
            code: 128,
            stderr: "fatal: couldn't find remote ref deadbeef\n",
        });
        expect(isUnreachableRefError(error)).toBe(true);
    });

    it("does NOT recover a fetch the timeout killed, even if its stderr names a missing ref", () => {
        // timedOut wins over the message: a killed child never completed the ref negotiation.
        const error = fetchBaseError({
            killed: true,
            signal: "SIGTERM",
            code: null,
            stderr: "fatal: not our ref deadbeef\n",
        });
        expect(isUnreachableRefError(error)).toBe(false);
    });

    it("does NOT recover a fetch an external signal killed (e.g. the OOM killer)", () => {
        const error = fetchBaseError({ killed: false, signal: "SIGKILL", code: null, stderr: "" });
        expect(isUnreachableRefError(error)).toBe(false);
    });

    it("does NOT recover a generic network failure", () => {
        const error = fetchBaseError({
            killed: false,
            signal: null,
            code: 128,
            stderr: "fatal: unable to access ...: Could not resolve host: github.com\n",
        });
        expect(isUnreachableRefError(error)).toBe(false);
    });
});
