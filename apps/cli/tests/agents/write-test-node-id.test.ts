import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { CoverageState, type FeatureNode } from "../../src/agents/05-test-generator/graph";
import { buildWriteTestTool } from "../../src/agents/05-test-generator/tools";

function spec(title: string) {
    return {
        title,
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

function makeNode(id: string): FeatureNode {
    return { id, name: id, sourceFiles: [], parentId: undefined, depth: 0, status: "queued" };
}

beforeAll(() => {
    process.env.DONT_TRACK = "1";
});

describe("write_test nodeId resolution", () => {
    let outputDir: string;

    async function write(state: CoverageState, nodeId: string, filename = "create-user.md", title = "Create a user") {
        const tool = buildWriteTestTool(state, outputDir);
        // The AI SDK types `execute` as optional on the tool wrapper.
        return await tool.execute?.(
            { folder: "admin", filename, test: spec(title), nodeId },
            { toolCallId: "call-1", messages: [], context: {} },
        );
    }

    beforeEach(async () => {
        outputDir = await mkdtemp(join(tmpdir(), "write-test-node-"));
    });

    afterEach(async () => {
        await rm(outputDir, { recursive: true });
    });

    test("an invented id during generation lands on the node being explored", async () => {
        const state = new CoverageState();
        state.enqueue(makeNode("admin-users"));
        state.nextNode();

        const result = await write(state, "admin/users");

        expect(result).toMatchObject({ path: "qa-tests/admin/create-user.md" });
        expect(state.nodes.get("admin-users")?.status).toBe("tested");
        expect([...state.testsWritten.keys()]).toEqual(["admin-users"]);
    });

    test("a review fix lands even though no node is being explored", async () => {
        const state = new CoverageState();
        state.enqueue(makeNode("admin-users"));
        state.nextNode();
        await write(state, "admin-users");

        // Generation ends: the queue drains and nextNode clears currentNode. The
        // review-fix pass runs from here, and its prompt never names a nodeId.
        state.nextNode();
        expect(state.currentNode).toBeUndefined();

        const result = await write(state, "admin/create-user.md", "create-user.md", "Create a user, fixed");

        expect(result).toMatchObject({ path: "qa-tests/admin/create-user.md" });
        await expect(readFile(join(outputDir, "qa-tests/admin/create-user.md"), "utf-8")).resolves.toContain(
            "Create a user, fixed",
        );
        expect(state.summary().totalTests).toBe(1);
    });

    test("a rewrite does not close the node being explored", async () => {
        const state = new CoverageState();
        state.enqueue(makeNode("admin-users"));
        state.enqueue(makeNode("admin-billing"));
        state.nextNode();
        await write(state, "admin-users");
        expect(state.nextNode()?.node.id).toBe("admin-billing");

        await write(state, "made-up", "create-user.md", "Create a user, fixed");

        expect(state.nodes.get("admin-billing")?.status).toBe("exploring");
        expect([...state.testsWritten.keys()]).toEqual(["admin-users"]);
    });

    test("rejects a brand-new test when nothing can own it", async () => {
        const state = new CoverageState();
        state.enqueue(makeNode("admin-users"));

        const result = await write(state, "made-up", "brand-new.md");

        expect(result).toMatchObject({ error: expect.stringContaining("Unknown nodeId") });
        expect(state.allTestPaths()).toEqual([]);
    });
});
