import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadCases } from "../src/case-loader";
import { baseFrontmatterSchema } from "../src/frontmatter";

// A stand-in for a step's input schema with one required field, so a fixture
// missing it ("stale") fails to parse the same way a pre-`change` fixture does.
const inputSchema = z.object({ change: z.object({ baseSha: z.string(), headSha: z.string() }) });
const frontmatterSchema = baseFrontmatterSchema;

const VALID_INPUT = { change: { baseSha: "b", headSha: "h" } };
const STALE_INPUT = { unrelated: true };

let casesDir: string;

beforeEach(() => {
    casesDir = mkdtempSync(path.join(tmpdir(), "evals-cases-"));
});

afterEach(() => {
    rmSync(casesDir, { recursive: true, force: true });
});

function writeCase(name: string, input: unknown, skip: boolean): void {
    const dir = path.join(casesDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "input.json"), JSON.stringify(input));
    writeFileSync(path.join(dir, "expected.md"), `---\nskip: ${skip}\n---\n\nrubric body\n`);
}

function load() {
    return loadCases({ casesDir, inputSchema, frontmatterSchema });
}

describe("loadCases: skip protects a case at load time", () => {
    it("drops a skipped case whose input no longer parses, without failing the suite", () => {
        writeCase("good", VALID_INPUT, false);
        writeCase("stale-skipped", STALE_INPUT, true);

        const names = load().map((c) => c.name);

        expect(names).toContain("good");
        expect(names).not.toContain("stale-skipped");
    });

    it("throws naming the case when an active case's input fails to parse", () => {
        writeCase("stale-active", STALE_INPUT, false);

        expect(load).toThrow(/stale-active/);
    });

    it("still loads a skipped case whose files parse, so it reports as skipped", () => {
        writeCase("parked", VALID_INPUT, true);

        expect(load().map((c) => c.name)).toEqual(["parked"]);
    });
});
