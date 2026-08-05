import { describe, expect, test } from "vitest";
import { CliArgs } from "../../src/core/cli-args";
import { KNOWN_FLAGS, renderHelp } from "../../src/core/help";

function parse(line: string): CliArgs {
    return CliArgs.parse(line.split(" ").filter((token) => token.length > 0));
}

describe("CliArgs", () => {
    test("reads a value given either way round the separator", () => {
        expect(parse("--project /repo").value("project")).toBe("/repo");
        expect(parse("--project=/repo").value("project")).toBe("/repo");
    });

    // `--resume --project x` has to read as two flags. Treating "--project" as
    // --resume's value would swallow the next flag AND lose the project path.
    test("does not let one flag swallow the next", () => {
        const args = parse("--resume --project /repo");

        expect(args.has("resume")).toBe(true);
        expect(args.value("resume")).toBeUndefined();
        expect(args.value("project")).toBe("/repo");
    });

    // A flag with no value is a caller who forgot the value, not a caller who meant
    // "true" - so it must not read back as one.
    test("a valueless flag is present but has no value", () => {
        const args = parse("--project");

        expect(args.has("project")).toBe(true);
        expect(args.value("project")).toBeUndefined();
    });

    test("answers to every spelling of the same flag", () => {
        expect(parse("--coding-agent claude").value("agent", "coding-agent")).toBe("claude");
        expect(parse("--agent claude").value("agent", "coding-agent")).toBe("claude");
    });

    describe("list", () => {
        test("keeps every value when a flag is repeated", () => {
            expect(parse("--backend apps/api --backend apps/db").list("backend", "backends")).toEqual([
                "apps/api",
                "apps/db",
            ]);
        });

        test("expands a comma-separated list, so both spellings mean the same thing", () => {
            expect(parse("--backends apps/api,apps/db").list("backend", "backends")).toEqual(["apps/api", "apps/db"]);
        });

        test("gathers values across spellings", () => {
            expect(parse("--backend apps/api --backends apps/db").list("backend", "backends")).toEqual([
                "apps/api",
                "apps/db",
            ]);
        });

        // Asking for no backends is a real answer, and a different one from not asking:
        // the second falls back to what the run infers, the first must not.
        test("tells never-given apart from given-empty", () => {
            expect(parse("--project /repo").list("backend", "backends")).toBeUndefined();
            expect(parse("--backends").list("backend", "backends")).toEqual([]);
        });
    });

    describe("unrecognized", () => {
        test("says nothing about flags it knows", () => {
            expect(parse("--project /repo --non-interactive").unrecognized(KNOWN_FLAGS)).toEqual([]);
        });

        // The expensive typo: nothing refuses it, and the run then waits on questions
        // the caller has no way to answer.
        test("names back the flag a typo was probably meant to be", () => {
            expect(parse("--noninteractive").unrecognized(KNOWN_FLAGS)).toEqual([
                { given: "noninteractive", meant: "non-interactive" },
            ]);
        });

        test("reports a flag with no near match without inventing one", () => {
            expect(parse("--wholly-made-up").unrecognized(KNOWN_FLAGS)).toEqual([{ given: "wholly-made-up" }]);
        });
    });
});

describe("renderHelp", () => {
    // The help is generated from the same list the parser accepts, so this is really
    // asserting that the two cannot drift - a documented flag that is not accepted
    // reads as a bug in the run rather than in the docs.
    test("documents every flag the parser accepts", () => {
        const help = renderHelp();

        for (const flag of KNOWN_FLAGS) {
            expect(help).toContain(`--${flag}`);
        }
    });

    test("points an agent at the machine-readable documentation", () => {
        const help = renderHelp();

        expect(help).toContain("docs.autonoma.app/llms.txt");
        expect(help).toContain("docs.autonoma.app/llms-full.txt");
    });

    // Every input that could otherwise be a question has to be reachable as a flag,
    // or a run with nobody to ask cannot express it.
    test("carries a flag for each answer a headless run cannot be asked for", () => {
        for (const flag of ["non-interactive", "frontend", "backend", "agent", "permission-mode", "resume", "fresh"]) {
            expect(KNOWN_FLAGS.has(flag)).toBe(true);
        }
    });
});
