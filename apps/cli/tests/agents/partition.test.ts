import { describe, expect, it } from "vitest";
import { CoverageState, type FeatureNode } from "../../src/agents/05-test-generator/graph";
import { partitionByPage } from "../../src/agents/05-test-generator/partition";

function node(id: string, parentId?: string): FeatureNode {
    return { id, name: id, sourceFiles: [], parentId, depth: parentId ? 1 : 0, status: "queued" };
}

function graph(...nodes: FeatureNode[]): CoverageState {
    const state = new CoverageState();
    for (const n of nodes) state.enqueue(n);
    return state;
}

/** Which node ids a scope claims, for readable assertions. */
function owned(state: CoverageState, scope: { owns(id: string): boolean }): string[] {
    return [...state.nodes.keys()].filter((id) => scope.owns(id)).sort();
}

describe("partitionByPage", () => {
    it("keeps a page and its features in one slice", () => {
        const state = graph(node("dashboard"), node("send-money", "dashboard"), node("add-funds", "dashboard"));

        const [slice, ...rest] = partitionByPage(state);

        expect(rest).toHaveLength(0);
        expect(owned(state, slice!)).toEqual(["add-funds", "dashboard", "send-money"]);
    });

    it("gives each page its own slice", () => {
        const state = graph(node("dashboard"), node("send-money", "dashboard"), node("login"), node("form", "login"));

        const slices = partitionByPage(state);

        expect(slices).toHaveLength(2);
        expect(slices.map((s) => owned(state, s)).sort()).toEqual([
            ["dashboard", "send-money"],
            ["form", "login"],
        ]);
    });

    it("never lets two slices claim the same node", () => {
        const state = graph(node("a"), node("a1", "a"), node("b"), node("b1", "b"), node("b2", "b"));

        const slices = partitionByPage(state);

        for (const id of state.nodes.keys()) {
            expect(
                slices.filter((s) => s.owns(id)),
                id,
            ).toHaveLength(1);
        }
    });

    it("covers every node - an orphan anchors its own slice rather than vanishing", () => {
        // A feature whose parent page was never enqueued. Dropping it would lose
        // its tests silently, since no worker would ever be handed it.
        const state = graph(node("dashboard"), node("orphan", "page-that-was-never-queued"));

        const slices = partitionByPage(state);
        const covered = new Set(slices.flatMap((s) => owned(state, s)));

        expect(covered).toEqual(new Set(["dashboard", "orphan"]));
    });

    it("does not loop forever on a parent cycle", () => {
        const state = graph(node("a", "b"), node("b", "a"));

        expect(() => partitionByPage(state)).not.toThrow();
        expect(partitionByPage(state).length).toBeGreaterThan(0);
    });
});

describe("CoverageState worker scoping", () => {
    it("hands each worker only its own nodes", () => {
        const state = graph(node("dashboard"), node("send-money", "dashboard"), node("login"));
        const [a, b] = partitionByPage(state);

        const first = state.nextNode(a!);
        const second = state.nextNode(b!);

        expect(a!.owns(first!.node.id)).toBe(true);
        expect(b!.owns(second!.node.id)).toBe(true);
        expect(first!.node.id).not.toBe(second!.node.id);
    });

    it("does not consume another worker's node while scanning past it", () => {
        const state = graph(node("dashboard"), node("login"));
        const slices = partitionByPage(state);
        const dashboard = slices.find((s) => s.owns("dashboard"))!;
        const login = slices.find((s) => s.owns("login"))!;

        // Drain the dashboard worker completely first.
        state.nextNode(dashboard);
        expect(state.nextNode(dashboard)).toBeUndefined();

        // The login node must still be there for its own worker.
        expect(state.nextNode(login)?.node.id).toBe("login");
    });

    it("skipping on advance only touches the worker's own node", () => {
        const state = graph(node("dashboard"), node("d1", "dashboard"), node("login"));
        const slices = partitionByPage(state);
        const dashboard = slices.find((s) => s.owns("dashboard"))!;
        const login = slices.find((s) => s.owns("login"))!;

        state.nextNode(login); // login is now "exploring"
        state.nextNode(dashboard);
        state.nextNode(dashboard); // advancing dashboard must not skip login

        expect(state.nodes.get("login")?.status).toBe("exploring");
    });

    it("reports remaining work per worker, not for the whole run", () => {
        const state = graph(node("dashboard"), node("d1", "dashboard"), node("d2", "dashboard"), node("login"));
        const slices = partitionByPage(state);
        const dashboard = slices.find((s) => s.owns("dashboard"))!;

        expect(state.remainingFor(dashboard)).toBe(3);
        state.nextNode(dashboard);
        expect(state.remainingFor(dashboard)).toBe(2);
    });
});
