import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import {
    ALL_NODES,
    BFS_STATE_FILE,
    CoverageState,
    estimateExpectedTests,
    type FeatureNode,
    JOURNEY_STATE_FILE,
    saveBfsState,
    loadBfsState,
    type WorkerScope,
} from "../../src/agents/05-test-generator/graph";

/** A worker that owns exactly one page id, for scoped-drain assertions. */
function pageWorker(id: string): WorkerScope {
    return { id, owns: (nodeId: string) => nodeId === id };
}

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

    test("markTested refuses an id no node owns instead of recording a phantom entry", () => {
        const state = new CoverageState();
        state.enqueue(makeNode({ id: "real" }));

        // An invented id must not write a phantom key that counts against nothing.
        state.markTested("ghost", ["qa-tests/real/create.md"]);

        expect(state.testsWritten.has("ghost")).toBe(false);
        expect(state.allTestPaths()).toEqual([]);
        expect(state.summary().totalTests).toBe(0);
        // The real node is untouched.
        expect(state.nodes.get("real")?.status).toBe("queued");
    });

    test("allTestPaths collects all test paths", () => {
        const state = new CoverageState();
        state.enqueue(makeNode({ id: "a" }));
        state.enqueue(makeNode({ id: "b" }));
        state.markTested("a", ["test1.md", "test2.md"]);
        state.markTested("b", ["test3.md"]);

        expect(state.allTestPaths()).toEqual(["test1.md", "test2.md", "test3.md"]);
    });

    test("re-writing the same test under one node counts it once", () => {
        const state = new CoverageState();
        state.enqueue(makeNode({ id: "a" }));
        state.markTested("a", ["qa-tests/auth/login.md"]);
        state.markTested("a", ["qa-tests/auth/login.md"]);

        expect(state.testsWritten.get("a")).toEqual(["qa-tests/auth/login.md"]);
        expect(state.summary().totalTests).toBe(1);
    });

    test("the same test recorded under two nodes counts once", () => {
        const state = new CoverageState();
        state.enqueue(makeNode({ id: "a" }));
        state.enqueue(makeNode({ id: "b" }));
        state.markTested("a", ["qa-tests/auth/login.md"]);
        state.markTested("b", ["qa-tests/auth/login.md", "qa-tests/auth/logout.md"]);

        expect(state.allTestPaths()).toEqual(["qa-tests/auth/login.md", "qa-tests/auth/logout.md"]);
        expect(state.summary().totalTests).toBe(2);
    });

    test("resolveNodeId passes a known id through", () => {
        const state = new CoverageState();
        state.enqueue(makeNode({ id: "admin-claims" }));
        expect(state.resolveNodeId("admin-claims", "qa-tests/admin/claims/create.md")).toBe("admin-claims");
    });

    test("resolveNodeId maps an invented id onto the node being explored", () => {
        const state = new CoverageState();
        state.enqueue(makeNode({ id: "admin-claims" }));
        state.nextNode();

        // The shapes models actually produce: a re-slug, a path, the filename.
        const path = "qa-tests/admin/claims/create.md";
        expect(state.resolveNodeId("admin/claims", path)).toBe("admin-claims");
        expect(state.resolveNodeId("admin-claims-update", path)).toBe("admin-claims");
        expect(state.resolveNodeId("qa-tests/admin/claims/create.md", path)).toBe("admin-claims");
    });

    test("resolveNodeId attributes a rewrite to the node that first wrote it", () => {
        const state = new CoverageState();
        state.enqueue(makeNode({ id: "admin-claims" }));
        state.enqueue(makeNode({ id: "admin-users" }));
        state.nextNode();
        state.markTested("admin-claims", ["qa-tests/admin/claims/create.md"]);

        // Generation ends: the queue drains and nextNode clears currentNode. This
        // is the state the review-fix pass inherits, and its prompt never tells the
        // agent a nodeId - so without the path lookup every fix write is rejected
        // and the whole review-fix cycle silently does nothing.
        state.nextNode();
        state.nextNode();
        expect(state.exploring()).toBeUndefined();

        expect(state.resolveNodeId("admin/claims/create.md", "qa-tests/admin/claims/create.md")).toBe("admin-claims");
    });

    test("resolveNodeId prefers the owning node over the one being explored", () => {
        const state = new CoverageState();
        state.enqueue(makeNode({ id: "admin-claims" }));
        state.enqueue(makeNode({ id: "admin-users" }));
        state.nextNode();
        state.markTested("admin-claims", ["qa-tests/admin/claims/create.md"]);
        const exploring = state.nextNode();
        expect(exploring?.node.id).toBe("admin-users");

        // A touch-up of a test admin-claims owns must not close admin-users.
        expect(state.resolveNodeId("whatever", "qa-tests/admin/claims/create.md")).toBe("admin-claims");
        expect(state.nodes.get("admin-users")?.status).toBe("exploring");
    });

    test("resolveNodeId gives up when nothing is being explored", () => {
        const state = new CoverageState();
        state.enqueue(makeNode({ id: "a" }));
        expect(state.resolveNodeId("made-up", "qa-tests/admin/new.md")).toBeUndefined();
    });

    test("an invented id does not strand its node in the queue", () => {
        const state = new CoverageState();
        state.enqueue(makeNode({ id: "admin-claims" }));
        state.enqueue(makeNode({ id: "admin-users" }));

        const first = state.nextNode();
        expect(first?.node.id).toBe("admin-claims");
        // The model invents an id; without resolution this would create a phantom
        // key, leave admin-claims un-tested, and re-issue it from the queue.
        const resolved = state.resolveNodeId("admin/claims", "qa-tests/admin/claims/create.md");
        state.markTested(resolved!, ["qa-tests/admin/claims/create.md"]);

        expect(state.nodes.get("admin-claims")?.status).toBe("tested");
        expect([...state.testsWritten.keys()]).toEqual(["admin-claims"]);
        expect(state.nextNode()?.node.id).toBe("admin-users");
        expect(state.summary().totalTests).toBe(1);
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

describe("hasDrained (worker-scoped termination)", () => {
    test("a queued worker has not drained", () => {
        const state = new CoverageState();
        state.enqueue(makeNode({ id: "a" }));
        expect(state.hasDrained(pageWorker("a"))).toBe(false);
    });

    test("a worker mid-exploration has not drained", () => {
        const state = new CoverageState();
        state.enqueue(makeNode({ id: "a" }));
        const a = pageWorker("a");

        state.nextNode(a);
        expect(state.exploring(a)).toBe("a");
        // Its queue is empty but the node is still open - finishing here would drop
        // the node's tests, so it must not count as drained.
        expect(state.remainingFor(a)).toBe(0);
        expect(state.hasDrained(a)).toBe(false);
    });

    test("a worker drains when its own slice is done, regardless of other workers' queues", () => {
        const state = new CoverageState();
        state.enqueue(makeNode({ id: "a" }));
        state.enqueue(makeNode({ id: "b" }));
        const a = pageWorker("a");
        const b = pageWorker("b");

        // Worker A processes its one node and asks again - next_node returns done
        // and clears its in-progress marker.
        state.nextNode(a);
        state.markTested("a", ["a.md"]);
        state.nextNode(a);

        // A is done even though B's node is still globally queued. This is the
        // regression: gating finish on the whole run's queue (queued > 0) kept A
        // spinning next_node until every other worker also drained.
        expect(state.summary().queued).toBe(1);
        expect(state.hasDrained(a)).toBe(true);
        expect(state.hasDrained(b)).toBe(false);
    });

    test("the default whole-graph worker drains only when nothing is left", () => {
        const state = new CoverageState();
        state.enqueue(makeNode({ id: "a" }));
        state.enqueue(makeNode({ id: "b" }));

        expect(state.hasDrained(ALL_NODES)).toBe(false);

        for (const id of ["a", "b"]) {
            state.nextNode();
            state.markTested(id, [`${id}.md`]);
        }
        state.nextNode();

        expect(state.hasDrained(ALL_NODES)).toBe(true);
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

    test("setReviewProgress replaces node progress with review-specific progress", async () => {
        const { createStore, setActiveStore } = await import("../../src/ui/store");
        const store = createStore({ outputDir: "/out", meta: { title: "t", project: "p", version: "0" } });
        setActiveStore(store);
        try {
            store.startStep("testGenerator");
            const state = new CoverageState();
            state.enqueue(makeNode({ id: "a" }));
            state.enqueue(makeNode({ id: "b" }));
            state.nextNode();
            state.markTested("a", ["qa-tests/a.md"]);
            state.nextNode();
            state.markTested("b", ["qa-tests/b.md"]);
            // Nodes are done: 2/2.
            expect(store.getState().steps.testGenerator.sub).toMatchObject({ done: 2, total: 2, unit: "nodes" });

            // The review pass replaces the sub-progress with its own ratio.
            state.setPhase("review cycle 1/4");
            state.setReviewProgress(3, 10, 12345);
            expect(store.getState().steps.testGenerator.sub).toMatchObject({
                done: 3,
                total: 10,
                unit: "reviewed",
                note: "review cycle 1/4",
                startedAt: 12345,
            });
        } finally {
            setActiveStore(undefined);
        }
    });

    test("clearReviewProgress restores the node-exploration sub-progress", async () => {
        const { createStore, setActiveStore } = await import("../../src/ui/store");
        const store = createStore({ outputDir: "/out", meta: { title: "t", project: "p", version: "0" } });
        setActiveStore(store);
        try {
            store.startStep("testGenerator");
            const state = new CoverageState();
            state.enqueue(makeNode({ id: "a" }));
            state.enqueue(makeNode({ id: "b" }));
            state.nextNode();
            state.markTested("a", ["qa-tests/a.md"]);
            state.nextNode();
            state.markTested("b", ["qa-tests/b.md"]);

            state.setPhase("review cycle 1/4");
            state.setReviewProgress(5, 10, 0);
            expect(store.getState().steps.testGenerator.sub?.unit).toBe("reviewed");

            state.clearReviewProgress();
            expect(store.getState().steps.testGenerator.sub).toMatchObject({
                done: 2,
                total: 2,
                unit: "nodes",
            });
        } finally {
            setActiveStore(undefined);
        }
    });

    test("clearReviewProgress settles rows left mid-review, keeping the verdicts", async () => {
        const { createStore, setActiveStore } = await import("../../src/ui/store");
        const store = createStore({ outputDir: "/out", meta: { title: "t", project: "p", version: "0" } });
        setActiveStore(store);
        try {
            store.startStep("testGenerator");
            const state = new CoverageState();
            state.enqueue(makeNode({ id: "a" }));
            state.nextNode();
            state.markTested("a", ["qa-tests/a.md"]);

            store.noteWrite("qa-tests/cleared.md");
            store.noteWrite("qa-tests/cut-off.md");
            store.setArtifactReview("qa-tests/cleared.md", "REVIEWED");
            store.setArtifactReview("qa-tests/cut-off.md", "REVIEWING");

            // The budget ran out mid-review: nothing may be left claiming to be
            // under review once the pass is over.
            state.clearReviewProgress();
            const s = store.getState();
            expect(s.artifacts["qa-tests/cleared.md"]?.status).toBe("REVIEWED");
            expect(s.artifacts["qa-tests/cut-off.md"]?.status).toBe("DONE");
        } finally {
            setActiveStore(undefined);
        }
    });
});

describe("state persistence is per-generator", () => {
    test("journey generation does not overwrite the BFS run's progress", async () => {
        const dir = await mkdtemp(join(tmpdir(), "autonoma-graph-"));
        try {
            const bfs = new CoverageState();
            bfs.enqueue(makeNode({ id: "checkout" }));
            bfs.markTested("checkout", ["qa-tests/checkout/pay.md"]);
            await saveBfsState(dir, bfs);

            // Journey tests run through the same write_test tool with their own
            // state; sharing a file made the first journey write erase the BFS
            // nodes and test paths that --resume depends on.
            const journey = new CoverageState({ stateFile: JOURNEY_STATE_FILE });
            journey.enqueue(makeNode({ id: "journeys" }));
            journey.markTested("journeys", ["qa-tests/journeys/signup-to-purchase.md"]);
            await saveBfsState(dir, journey);

            const resumed = await loadBfsState(dir);
            expect(resumed?.allTestPaths()).toEqual(["qa-tests/checkout/pay.md"]);
            expect(JOURNEY_STATE_FILE).not.toBe(BFS_STATE_FILE);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
    test("the journey pass leaves the tests step's node progress alone", async () => {
        const { createStore, setActiveStore } = await import("../../src/ui/store");
        const store = createStore({ outputDir: "/out", meta: { title: "t", project: "p", version: "0" } });
        setActiveStore(store);
        try {
            store.startStep("testGenerator");
            const bfs = new CoverageState();
            for (const id of ["a", "b"]) bfs.enqueue(makeNode({ id }));
            bfs.nextNode();
            bfs.markTested("a", ["qa-tests/a.md"]);
            bfs.nextNode();
            bfs.markTested("b", ["qa-tests/b.md"]);
            const finished = store.getState().steps.testGenerator.sub;
            expect(finished).toMatchObject({ done: 2, total: 2, unit: "nodes" });

            // Journey generation runs its own state over one synthetic node. Left
            // reporting, its first mutation rewrites the strip to "0/1 nodes" at
            // the moment the step reads as finished.
            const journey = new CoverageState({ stateFile: JOURNEY_STATE_FILE, reportsProgress: false });
            journey.enqueue(makeNode({ id: "journeys" }));
            journey.nextNode();
            journey.markTested("journeys", ["qa-tests/journeys/full.md"]);

            expect(store.getState().steps.testGenerator.sub).toEqual(finished);
        } finally {
            setActiveStore(undefined);
        }
    });
    test("a phase label replaces the test estimate, and survives writes during it", async () => {
        const { createStore, setActiveStore } = await import("../../src/ui/store");
        const store = createStore({ outputDir: "/out", meta: { title: "t", project: "p", version: "0" } });
        setActiveStore(store);
        try {
            store.startStep("testGenerator");
            const state = new CoverageState();
            for (const id of ["a", "b"]) state.enqueue(makeNode({ id }));
            state.nextNode();
            state.markTested("a", ["qa-tests/a.md"]);
            // While exploring, the note estimates the final test count.
            expect(store.getState().steps.testGenerator.sub?.note).toMatch(/tests$/);

            state.setPhase("review cycle 2/4");
            expect(store.getState().steps.testGenerator.sub).toMatchObject({
                done: 1,
                total: 2,
                unit: "nodes",
                note: "review cycle 2/4",
            });

            // The review-fix pass writes through this same state, so every fixed
            // test re-emits progress. The phase has to survive that.
            state.nextNode();
            state.markTested("b", ["qa-tests/b.md"]);
            expect(store.getState().steps.testGenerator.sub?.note).toBe("review cycle 2/4");
        } finally {
            setActiveStore(undefined);
        }
    });
});
