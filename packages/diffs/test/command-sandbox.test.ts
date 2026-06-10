import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSafeEnv } from "../src/agents/tools/codebase/bash-tool";
import { CommandSandbox } from "../src/agents/tools/codebase/command-sandbox";

const execFileAsync = promisify(execFile);

/** Probe for bubblewrap so the isolation suite only runs where it can run. */
function hasBwrap(): boolean {
    try {
        execFileSync("bwrap", ["--version"], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

interface RunResult {
    code: number;
    stdout: string;
    stderr: string;
}

/** Read the loosely-typed fields off a thrown `execFile` error without casting. */
function readRunResult(error: unknown): RunResult {
    const result: RunResult = { code: 1, stdout: "", stderr: "" };
    if (typeof error !== "object" || error === null) return result;
    if ("code" in error && typeof error.code === "number") result.code = error.code;
    if ("stdout" in error && typeof error.stdout === "string") result.stdout = error.stdout;
    if ("stderr" in error && typeof error.stderr === "string") result.stderr = error.stderr;
    return result;
}

// The degraded path is the security-relevant fallback: when bwrap is missing the
// command MUST run unsandboxed (isolation off) rather than fail closed, and the
// caller is told via the warning. We assert the observable shape of that fallback.
describe("CommandSandbox without bubblewrap (degraded)", () => {
    it("runs the command unsandboxed and forwards only the scrubbed env", () => {
        const sandbox = new CommandSandbox(false);
        const spec = sandbox.wrap("git status", "/tmp/codebase/seed", { PATH: "/usr/bin", HOME: "/root" });

        expect(sandbox.isolated).toBe(false);
        expect(spec.file).toBe("sh");
        expect(spec.args).toEqual(["-c", "git status"]);
        expect(spec.env).toEqual({ PATH: "/usr/bin", HOME: "/root" });
    });
});

// These spawn real `bwrap` and confirm each property fails-to-breach from inside
// the sandbox. They are skipped where bwrap is absent (macOS / local eval), which
// is exactly the degraded case covered by the unit test above.
describe.skipIf(!hasBwrap())("CommandSandbox with bubblewrap (isolated)", () => {
    let baseDir: string;
    let cloneRoot: string;
    let hostSecretPath: string;
    const sandbox = new CommandSandbox();

    const run = (command: string): Promise<RunResult> => {
        const spec = sandbox.wrap(command, cloneRoot, buildSafeEnv(process.env));
        return execFileAsync(spec.file, spec.args, {
            cwd: cloneRoot,
            env: spec.env,
            timeout: 20_000,
            maxBuffer: 4 * 1024 * 1024,
        })
            .then(({ stdout, stderr }) => ({ code: 0, stdout, stderr }))
            .catch(readRunResult);
    };

    beforeAll(() => {
        baseDir = mkdtempSync(join(tmpdir(), "command-sandbox-it-"));
        cloneRoot = join(baseDir, "clone");
        mkdirSync(cloneRoot);
        writeFileSync(join(cloneRoot, "file.txt"), "hello world\n");

        // A committed history so `git` read commands have something to report.
        execFileSync("git", ["init", "-q", "-b", "main", cloneRoot]);
        execFileSync("git", ["-C", cloneRoot, "config", "user.email", "test@autonoma.app"]);
        execFileSync("git", ["-C", cloneRoot, "config", "user.name", "test"]);
        execFileSync("git", ["-C", cloneRoot, "add", "."]);
        execFileSync("git", ["-C", cloneRoot, "commit", "-q", "-m", "seed commit"]);

        // A host file OUTSIDE the clone. The sandbox binds only the clone, so this
        // sibling must be invisible inside it.
        hostSecretPath = join(baseDir, "host-secret.txt");
        writeFileSync(hostSecretPath, "TOP_SECRET_HOST_DATA\n");
    });

    afterAll(() => {
        rmSync(baseDir, { recursive: true, force: true });
    });

    it("lets read-only commands run against the clone", async () => {
        const cat = await run("cat file.txt");
        expect(cat.code).toBe(0);
        expect(cat.stdout).toContain("hello world");

        // git works thanks to the injected safe.directory, with no host .gitconfig bound.
        const log = await run("git log --oneline");
        expect(log.code).toBe(0);
        expect(log.stdout).toContain("seed commit");
    });

    it("cannot write or modify files in the clone", async () => {
        const result = await run("sed -i 's/hello/HACKED/' file.txt");
        expect(result.code).not.toBe(0);
        expect(readFileSync(join(cloneRoot, "file.txt"), "utf8")).toBe("hello world\n");
    });

    it("cannot delete files in the clone", async () => {
        const result = await run("find . -name file.txt -delete");
        expect(result.code).not.toBe(0);
        expect(existsSync(join(cloneRoot, "file.txt"))).toBe(true);
    });

    it("cannot read host paths outside the clone", async () => {
        const result = await run(`cat ${hostSecretPath}`);
        expect(result.code).not.toBe(0);
        expect(result.stdout).not.toContain("TOP_SECRET_HOST_DATA");
        // The host file itself is untouched and still readable from outside the sandbox.
        expect(readFileSync(hostSecretPath, "utf8")).toContain("TOP_SECRET_HOST_DATA");
    });

    it("cannot reach the network", async () => {
        // Numeric host => no DNS/hosts-file dependency; an empty network namespace
        // makes the TCP connect fail immediately rather than time out.
        const result = await run("git ls-remote https://93.184.216.34/probe.git");
        expect(result.code).not.toBe(0);
    });

    it("cannot see worker secrets in the environment", async () => {
        process.env.FAKE_WORKER_SECRET = "s3cr3t-must-not-leak";
        try {
            const result = await run('echo "[$FAKE_WORKER_SECRET]"');
            expect(result.code).toBe(0);
            expect(result.stdout.trim()).toBe("[]");
        } finally {
            delete process.env.FAKE_WORKER_SECRET;
        }
    });
});
