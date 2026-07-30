import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { reportSubProgress } from "../../core/progress";

/** Persisted BFS progress: which nodes are explored and what each one wrote. */
export const BFS_STATE_FILE = ".bfs-state.json";
/** Journey generation's own progress, kept apart from the BFS run's. */
export const JOURNEY_STATE_FILE = ".journey-state.json";

/** Prior tests-per-node until the run has enough real data to measure its own. */
const TESTS_PER_NODE_PRIOR = 3;
/** Processed nodes needed before trusting the run's own tests/node ratio. */
const LIVE_RATE_MIN_PROCESSED = 3;

/**
 * Estimate the final test count. The total isn't known upfront - each node's
 * test count is only decided as its source is read - so project from the run's
 * own tests/node ratio once a few nodes are done, a prior before that. Never
 * below what's already written.
 */
export function estimateExpectedTests(written: number, processed: number, totalNodes: number): number {
    if (totalNodes <= 0) return written;
    const rate = written > 0 && processed >= LIVE_RATE_MIN_PROCESSED ? written / processed : TESTS_PER_NODE_PRIOR;
    return Math.max(written, Math.round(rate * totalNodes));
}

export interface FeatureNode {
    id: string;
    name: string;
    routePath?: string;
    sourceFiles: string[];
    parentId?: string;
    depth: number;
    status: "queued" | "exploring" | "tested" | "skipped";
}

export interface SerializedCoverageState {
    nodes: Record<string, FeatureNode>;
    queue: string[];
    currentNode?: string;
    testsWritten: Record<string, string[]>;
}

export interface CoverageStateOptions {
    /**
     * Where this state persists. Journey generation runs a second, independent
     * CoverageState through the same write_test tool; without its own file its
     * first write would overwrite the BFS run's file, dropping every node and
     * test path a --resume needs.
     */
    stateFile?: string;
    /**
     * Whether this state's node progress reaches the dashboard. The journey pass
     * explores one synthetic node, so reporting it as the tests step's node
     * progress replaces a finished "139/139 nodes" with "0/1 nodes" at the moment
     * the run looks done, which reads as the step starting over.
     */
    reportsProgress?: boolean;
}

export class CoverageState {
    nodes: Map<string, FeatureNode> = new Map();
    queue: string[] = [];
    testsWritten: Map<string, string[]> = new Map();
    currentNode?: string;

    readonly stateFile: string;
    private readonly reportsProgress: boolean;
    private phase?: string;

    constructor(options: CoverageStateOptions = {}) {
        this.stateFile = options.stateFile ?? BFS_STATE_FILE;
        this.reportsProgress = options.reportsProgress ?? true;
    }

    enqueue(node: FeatureNode): boolean {
        if (this.nodes.has(node.id)) return false;
        this.nodes.set(node.id, node);
        this.queue.push(node.id);
        this.reportProgress();
        return true;
    }

    nextNode(): { node: FeatureNode; remaining: number } | undefined {
        if (this.currentNode) {
            const current = this.nodes.get(this.currentNode);
            if (current && current.status !== "tested") {
                current.status = "skipped";
                this.reportProgress();
            }
        }

        while (this.queue.length > 0) {
            const id = this.queue.shift()!;
            const node = this.nodes.get(id);
            if (!node || node.status === "tested" || node.status === "skipped") continue;

            node.status = "exploring";
            this.currentNode = id;
            return { node, remaining: this.queue.length };
        }

        this.currentNode = undefined;
        return undefined;
    }

    /**
     * Map whatever the model called the node onto a real one. `write_test` takes
     * the id as free text, and models routinely re-slug it, path-ify it, or pass
     * the test filename - none of which match a node. Recording under the given
     * string anyway invents a key that no node owns: the real node never flips to
     * "tested", `next_node` hands it out again, and the same test is written and
     * counted twice.
     *
     * Resolution order matters. The path comes before the explored node because a
     * rewrite of an existing test belongs to whichever node first wrote it, not to
     * whatever happens to be in progress - that is how the review-fix pass, which
     * runs with no node explored at all, attributes its rewrites, and it keeps a
     * mid-exploration touch-up of an already-tested file from closing the node
     * being explored.
     *
     * Returns undefined only when there is nothing to attribute to, so the caller
     * can reject instead of guessing.
     */
    resolveNodeId(nodeId: string, testPath: string): string | undefined {
        if (this.nodes.has(nodeId)) return nodeId;

        const owner = this.nodeOwningTest(testPath);
        if (owner != null) return owner;

        if (this.currentNode != null && this.nodes.has(this.currentNode)) return this.currentNode;
        return undefined;
    }

    /** The node that already recorded this test path, if any. */
    private nodeOwningTest(testPath: string): string | undefined {
        for (const [nodeId, paths] of this.testsWritten) {
            if (paths.includes(testPath) && this.nodes.has(nodeId)) return nodeId;
        }
        return undefined;
    }

    markTested(nodeId: string, testPaths: string[]): void {
        const node = this.nodes.get(nodeId);
        if (node) node.status = "tested";
        const existing = this.testsWritten.get(nodeId) ?? [];
        const merged = [...existing];
        for (const path of testPaths) {
            if (!merged.includes(path)) merged.push(path);
        }
        this.testsWritten.set(nodeId, merged);
        this.reportProgress();
    }

    /**
     * Every distinct test file written this run. Deduped across nodes as well as
     * within one: a test rewritten under a second node (a review fix, a re-visited
     * node) is still one file on disk, and counting it twice inflates every number
     * derived from this - the progress estimate, the run summary, and INDEX.md.
     */
    allTestPaths(): string[] {
        const paths: string[] = [];
        const seen = new Set<string>();
        for (const tests of this.testsWritten.values()) {
            for (const path of tests) {
                if (seen.has(path)) continue;
                seen.add(path);
                paths.push(path);
            }
        }
        return paths;
    }

    /**
     * What the step is doing now, for the phases that follow node exploration:
     * journey generation, the review cycles, the validation sweep. Node
     * exploration needs no label - its ratio already says so.
     *
     * Routed through this state rather than reported separately because
     * write_test keeps running during those phases, and every write re-emits
     * progress. A second writer to the same slot would race it and flicker.
     */
    setPhase(phase: string | undefined): void {
        this.phase = phase;
        this.reportProgress();
    }

    /** Processed nodes (tested or skipped) over the known graph size, labelled
     * with the running phase or - while exploring - a live estimate of the final
     * test count, which isn't known upfront (each node's test count is decided as
     * its source is read). */
    private reportProgress(): void {
        if (!this.reportsProgress) return;
        const stats = this.summary();
        const processed = stats.tested + stats.skipped;
        const expected = estimateExpectedTests(stats.totalTests, processed, stats.totalNodes);
        reportSubProgress("testGenerator", processed, stats.totalNodes, "nodes", this.phase ?? `~${expected} tests`);
    }

    summary(): {
        totalNodes: number;
        tested: number;
        skipped: number;
        queued: number;
        totalTests: number;
    } {
        let tested = 0,
            skipped = 0,
            queued = 0;
        for (const node of this.nodes.values()) {
            if (node.status === "tested") tested++;
            else if (node.status === "skipped") skipped++;
            else queued++;
        }
        return {
            totalNodes: this.nodes.size,
            tested,
            skipped,
            queued,
            totalTests: this.allTestPaths().length,
        };
    }

    serialize(): SerializedCoverageState {
        return {
            nodes: Object.fromEntries(this.nodes),
            queue: [...this.queue],
            currentNode: this.currentNode,
            testsWritten: Object.fromEntries(this.testsWritten),
        };
    }

    static deserialize(data: SerializedCoverageState, options: CoverageStateOptions = {}): CoverageState {
        const state = new CoverageState(options);
        state.nodes = new Map(Object.entries(data.nodes));
        state.queue = data.queue;
        state.currentNode = data.currentNode ?? undefined;
        state.testsWritten = new Map(Object.entries(data.testsWritten));
        return state;
    }
}

export async function saveBfsState(outputDir: string, state: CoverageState): Promise<void> {
    const path = join(outputDir, state.stateFile);
    await writeFile(path, JSON.stringify(state.serialize(), null, 2), "utf-8");
}

export async function loadBfsState(outputDir: string): Promise<CoverageState | undefined> {
    const path = join(outputDir, BFS_STATE_FILE);
    try {
        const raw = await readFile(path, "utf-8");
        return CoverageState.deserialize(JSON.parse(raw));
    } catch {
        return undefined;
    }
}
