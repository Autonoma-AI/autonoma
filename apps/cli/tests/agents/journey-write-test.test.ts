import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { CoverageState, JOURNEY_STATE_FILE } from "../../src/agents/05-test-generator/graph";
import { buildWriteTestTool } from "../../src/agents/05-test-generator/tools";

const JOURNEY = `---
title: "Document lifecycle"
description: "Create, author and sign a document end to end"
intent: "A document created and sent for signing keeps its recipient list intact through signing"
criticality: critical
scenario: standard
flow: "core"
verification: "Navigate to the document list and assert the signed document is listed as completed"
---

**Intent**: Cross-feature flow.

**Steps**
1. click: New document
2. type: Ada Lovelace
3. assert: Ada Lovelace
`;

beforeAll(() => {
    process.env.DONT_TRACK = "1";
});

/**
 * The state generateJourneyTests builds: one node, and no next_node tool, so the
 * only thing that can put a node in progress is the explicit nextNode() call.
 */
function journeyState(): CoverageState {
    const state = new CoverageState({ stateFile: JOURNEY_STATE_FILE });
    state.enqueue({
        id: "journeys",
        name: "Journey Tests",
        sourceFiles: [],
        parentId: undefined,
        depth: 0,
        status: "queued",
    });
    state.nextNode();
    return state;
}

describe("journey generation write path", () => {
    let outputDir: string;

    beforeEach(async () => {
        outputDir = await mkdtemp(join(tmpdir(), "journey-write-"));
    });

    afterEach(async () => {
        await rm(outputDir, { recursive: true, force: true });
    });

    // The three shapes seen in a real run's state file. Only the first matches a
    // node; the others have to resolve against the node in progress.
    test.each(["journeys", "journeys/document-lifecycle.md", "journey-document-lifecycle"])(
        "accepts a journey test written under nodeId %j",
        async (nodeId) => {
            const tool = buildWriteTestTool(journeyState(), outputDir);

            const result = await tool.execute?.(
                { folder: "journeys", filename: "document-lifecycle.md", content: JOURNEY, nodeId },
                { toolCallId: "call-1", messages: [] },
            );

            expect(result).toMatchObject({ path: "qa-tests/journeys/document-lifecycle.md" });
        },
    );

    test("records every journey test under the one real node", async () => {
        const state = journeyState();
        const tool = buildWriteTestTool(state, outputDir);

        for (const filename of ["first.md", "second.md"]) {
            await tool.execute?.(
                { folder: "journeys", filename, content: JOURNEY, nodeId: `journeys/${filename}` },
                { toolCallId: "call-1", messages: [] },
            );
        }

        expect([...state.testsWritten.keys()]).toEqual(["journeys"]);
        expect(state.allTestPaths()).toEqual(["qa-tests/journeys/first.md", "qa-tests/journeys/second.md"]);
    });
});
