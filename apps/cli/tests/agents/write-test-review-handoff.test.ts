import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CoverageState } from "../../src/agents/05-test-generator/graph";
import type { WrittenTest } from "../../src/agents/05-test-generator/review";
import { buildWriteTestTool } from "../../src/agents/05-test-generator/tools";

/**
 * The handoff from write_test to the review pipeline, exercised with the REAL
 * path resolution on both sides.
 *
 * The pipeline's own tests stub the reviewer, so they verify scheduling and prove
 * nothing about what a path means to each side. The two disagreed - write_test
 * emitted an output-dir-relative path and the reviewer resolved it against the
 * tests dir - and because a missing test file is swallowed as a debug log, the
 * whole pipeline reviewed nothing without a single error.
 */
beforeAll(() => {
    process.env.DONT_TRACK = "1";
});

function spec() {
    return {
        title: "Create a user",
        description: "Creates a user from the admin panel",
        intent: "Creating a user from the admin panel adds them to the user list so the team can see it",
        criticality: "high" as const,
        scenario: "standard",
        flow: "admin",
        verification: "Navigate to the user list and assert the new user's row is present",
        setup: "The user is on the admin panel.",
        steps: [
            { verb: "click" as const, description: 'the "New user" button', location: "in the page header" },
            {
                verb: "type" as const,
                description: '"Ada Lovelace" into the Name field',
                location: "in the new-user modal",
            },
            { verb: "assert" as const, description: 'text "Ada Lovelace"', location: "in the user list" },
        ],
        verificationSteps: [],
        expectedResult: "Ada Lovelace appears in the user list.",
    };
}

describe("write_test -> review handoff", () => {
    let outputDir: string;

    beforeEach(async () => {
        outputDir = await mkdtemp(join(tmpdir(), "handoff-"));
    });

    afterEach(async () => {
        await rm(outputDir, { recursive: true, force: true });
    });

    it("hands over the exact content and a path the reviewer resolves correctly", async () => {
        const state = new CoverageState();
        state.enqueue({ id: "admin", name: "admin", sourceFiles: [], parentId: undefined, depth: 0, status: "queued" });
        state.nextNode();

        const handedOver: WrittenTest[] = [];
        const tool = buildWriteTestTool(state, outputDir, (test) => handedOver.push(test));

        await tool.execute?.(
            { folder: "admin", filename: "create-user.md", test: spec(), nodeId: "admin" },
            { toolCallId: "call-1", messages: [], context: {} },
        );

        expect(handedOver).toHaveLength(1);
        const [written] = handedOver;

        // The content handed over is what review sees, so it must match the file
        // byte for byte - a reviewer judging something other than what shipped is
        // worse than no reviewer.
        const { readFile } = await import("node:fs/promises");
        const onDisk = await readFile(join(outputDir, "qa-tests", written!.relativePath), "utf-8");

        expect(written!.content).toBe(onDisk);
        expect(written!.flow).toBe("admin");
        // Relative to the TESTS dir. Output-dir-relative would resolve to
        // qa-tests/qa-tests/... , which is how the pipeline once reviewed nothing.
        expect(written!.relativePath).toBe("admin/create-user.md");
    });
});
