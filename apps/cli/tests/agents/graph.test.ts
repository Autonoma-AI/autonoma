import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import {
    CoverageState,
    estimateExpectedTests,
    type FeatureNode,
    saveBfsState,
    loadBfsState,
} from "../../src/agents/05-test-generator/graph";

function makeNode(overrides: Partial<FeatureNode> = {}): FeatureNode {
    return {
        id: "test-node",
        name: "Test Node",
        sourceFiles: ["src/test.ts"],
        parentId: undefined,
        depth: 0,
        status: "queued",
        ...overrides,
    };
}

describe("CoverageState", () => {
    test("enqueue adds a node and returns true", () => {
        const state = new CoverageState();
        expect(state.enqueue(makeNode())).toBe(true);
        expect(state.nodes.size).toBe(1);
        expect(state.queue).toHaveLength(1);
    });

    test("enqueue rejects duplicates", () => {
        const state = new CoverageState();
        state.enqueue(makeNode({ id: "a" }));
        expect(state.enqueue(makeNode({ id: "a" }))).toBe(false);
        expect(state.nodes.size).toBe(1);
    });

    test("nextNode returns nodes in FIFO order", () => {
        const state = new CoverageState();
        state.enqueue(makeNode({ id: "a", name: "A" }));
        state.enqueue(makeNode({ id: "b", name: "B" }));

        const first = state.nextNode();
        expect(first?.node.id).toBe("a");
        expect(first?.node.status).toBe("exploring");

        state.markTested("a", ["t1.md"]);
        const second = state.nextNode();
        expect(second?.node.id).toBe("b");
    });

    test("nextNode returns null when empty", () => {
        const state = new CoverageState();
        expect(state.nextNode()).toBeUndefined();
    });

    test("nextNode auto-skips previous node if not tested", () => {
        const state = new CoverageState();
        state.enqueue(makeNode({ id: "a" }));
        state.enqueue(makeNode({ id: "b" }));

        state.nextNode(); // gets "a", sets it as currentNode
        // don't mark "a" as tested - call nextNode again
        const second = state.nextNode();
        expect(second?.node.id).toBe("b");
        expect(state.nodes.get("a")?.status).toBe("skipped");
    });

    test("markTested updates node status and records tests", () => {
        const state = new CoverageState();
        state.enqueue(makeNode({ id: "a" }));
        state.markTested("a", ["qa-tests/auth/login.md"]);

        expect(state.nodes.get("a")?.status).toBe("tested");
        expect(state.testsWritten.get("a")).toEqual(["qa-tests/auth/login.md"]);
    });

    test("allTestPaths collects all test paths", () => {
        const state = new CoverageState();
        state.enqueue(makeNode({ id: "a" }));
        state.enqueue(makeNode({ id: "b" }));
        state.markTested("a", ["test1.md", "test2.md"]);
        state.markTested("b", ["test3.md"]);

        expect(state.allTestPaths()).toEqual(["test1.md", "test2.md", "test3.md"]);
    });

    test("summary returns correct counts", () => {
        const state = new CoverageState();
        state.enqueue(makeNode({ id: "a" }));
        state.enqueue(makeNode({ id: "b" }));
        state.enqueue(makeNode({ id: "c" }));
        state.markTested("a", ["t1.md"]);
        const nodeB = state.nodes.get("b");
        if (nodeB) nodeB.status = "skipped";

        const stats = state.summary();
        expect(stats.totalNodes).toBe(3);
        expect(stats.tested).toBe(1);
        expect(stats.skipped).toBe(1);
        expect(stats.totalTests).toBe(1);
    });
});

describe("serialization", () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await mkdtemp(join(tmpdir(), "test-bfs-"));
    });

    afterEach(async () => {
        await rm(tempDir, { recursive: true });
    });

    test("serialize and deserialize round-trip", () => {
        const state = new CoverageState();
        state.enqueue(makeNode({ id: "a" }));
        state.enqueue(makeNode({ id: "b" }));
        state.markTested("a", ["t1.md"]);

        const serialized = state.serialize();
        const restored = CoverageState.deserialize(serialized);

        expect(restored.nodes.size).toBe(2);
        expect(restored.testsWritten.get("a")).toEqual(["t1.md"]);
        expect(restored.queue).toEqual(["a", "b"]);
    });

    test("saveBfsState and loadBfsState round-trip", async () => {
        const state = new CoverageState();
        state.enqueue(makeNode({ id: "x" }));
        state.markTested("x", ["test.md"]);

        await saveBfsState(tempDir, state);
        const loaded = await loadBfsState(tempDir);

        expect(loaded).not.toBeUndefined();
        expect(loaded!.nodes.size).toBe(1);
        expect(loaded!.testsWritten.get("x")).toEqual(["test.md"]);
    });

    test("loadBfsState returns null when file doesn't exist", async () => {
        const loaded = await loadBfsState(tempDir);
        expect(loaded).toBeUndefined();
    });
});

describe("estimateExpectedTests", () => {
    test("uses the ~3/node prior before enough nodes are processed", () => {
        // 1 node done, 2 tests: too little data, prior 3/node x 40 nodes.
        expect(estimateExpectedTests(2, 1, 40)).toBe(120);
    });

    test("projects from the run's own tests/node ratio once enough is observed", () => {
        // 4 nodes done, 8 tests -> 2 tests/node x 40 nodes = 80.
        expect(estimateExpectedTests(8, 4, 40)).toBe(80);
    });

    test("never estimates fewer than already written", () => {
        // Sparse tail (many skips) would project low; clamp to written.
        expect(estimateExpectedTests(50, 40, 41)).toBe(51);
        expect(estimateExpectedTests(50, 40, 40)).toBe(50);
    });

    test("no nodes yet -> just what's written", () => {
        expect(estimateExpectedTests(0, 0, 0)).toBe(0);
    });
});

describe("dashboard sub-progress reporting", () => {
    test("graph mutations report processed/total nodes to the active store", async () => {
        const { createStore, setActiveStore } = await import("../../src/ui/store");
        const store = createStore({ outputDir: "/out", meta: { title: "t", project: "p", version: "0" } });
        setActiveStore(store);
        try {
            store.startStep("testGenerator");
            const state = new CoverageState();
            state.enqueue(makeNode({ id: "a" }));
            state.enqueue(makeNode({ id: "b" }));
            expect(store.getState().steps.testGenerator.sub).toEqual({
                done: 0,
                total: 2,
                unit: "nodes",
                note: "~6 tests",
            });

            state.nextNode();
            state.markTested("a", ["qa-tests/a.md"]);
            expect(store.getState().steps.testGenerator.sub).toEqual({
                done: 1,
                total: 2,
                unit: "nodes",
                note: "~6 tests",
            });
        } finally {
            setActiveStore(undefined);
        }
    });
});
