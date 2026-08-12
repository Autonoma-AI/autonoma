import { type CoverageState, type WorkerScope } from "./graph";

/**
 * Split the node graph into slices one generator agent each can own.
 *
 * The unit is a PAGE and everything beneath it, not a node. Sibling features of
 * one page are where duplication actually happens - two tabs of the same modal,
 * a form and the dialog around it - and a real run produced exactly that: one
 * agent wrote "Transfer money from Savings to Checking" under the internal
 * transfer node and "Transfer money from Checking to Savings" under the external
 * one, sibling children of the same page. Keeping a page whole gives each worker
 * the same locality the single sequential agent had, so parallelism does not make
 * that worse. Across pages the overlap is rare, and the claim registry catches
 * what is left.
 *
 * Depth-0 nodes with no parent anchor a slice; a feature joins its parent's.
 * Anything orphaned (a feature whose parent page was never queued) forms its own,
 * so no node is silently dropped from the run.
 */
export function partitionByPage(state: CoverageState): WorkerScope[] {
    const membersByRoot = new Map<string, Set<string>>();

    for (const node of state.nodes.values()) {
        const root = pageRootOf(state, node.id);
        const members = membersByRoot.get(root) ?? new Set<string>();
        members.add(node.id);
        membersByRoot.set(root, members);
    }

    return [...membersByRoot.entries()].map(([root, members]) => ({
        id: root,
        owns: (nodeId: string) => members.has(nodeId),
    }));
}

/**
 * Walk up parentId to the page a node belongs to, tolerating a broken chain.
 *
 * The same notion of "page" the worker partition uses, exported so the smoke
 * floor can be counted per page: a page and every feature beneath it resolve to
 * one key, so the page draws its one guaranteed test exactly once.
 */
export function pageRootOf(state: CoverageState, nodeId: string): string {
    const seen = new Set<string>();
    let current = nodeId;

    while (!seen.has(current)) {
        seen.add(current);
        const node = state.nodes.get(current);
        // A parent that was never enqueued cannot own the slice, so the node
        // anchors its own rather than vanishing from every worker's scope.
        if (node?.parentId == null || !state.nodes.has(node.parentId)) return current;
        current = node.parentId;
    }
    return current;
}
