import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { reportSubProgress } from "../../core/progress";
import { getActiveStore } from "../../ui/store";

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

/** The id the single sequential generator explores under. */
export const DEFAULT_WORKER_ID = "main";

/**
 * The slice of the graph one generator agent may take.
 *
 * Parallel generation partitions by PAGE, not by node: sibling features of one
 * page are the ones most likely to overlap - two tabs of the same modal, a form
 * and the dialog around it - so keeping them with one agent preserves exactly the
 * locality a single sequential agent had. Across pages, overlap is rare and the
 * claim registry catches what is left.
 */
export interface WorkerScope {
    id: string;
    owns(nodeId: string): boolean;
}

/** The whole graph, which is what a sequential run walks. */
export const ALL_NODES: WorkerScope = { id: DEFAULT_WORKER_ID, owns: () => true };

export interface FeatureNode {
    id: string;
    name: string;
    routePath?: string;
    sourceFiles: string[];
    parentId?: string;
    depth: number;
    status: "queued" | "exploring" | "tested" | "skipped";
    /**
     * What this feature is for, carried over from feature discovery. This is the
     * node's mission: the one thing it must do correctly, which every test for the
     * node has to verify. Feature discovery already writes it into features.json -
     * dropping it here left the prompt telling the model to look up a mission that
     * was never handed to it.
     */
    description?: string;
    /** How many interactive elements discovery counted, so test depth can be proportional to it. */
    interactiveElements?: number;
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
    /** The node each worker is exploring, keyed by worker id. */
    private readonly currentNodes = new Map<string, string>();

    /** Nodes still queued for a worker - what it has left, not what the run has left. */
    remainingFor(worker: WorkerScope = ALL_NODES): number {
        return this.queue.filter((id) => worker.owns(id)).length;
    }

    /** The node a given worker is exploring, if any. Undefined once its queue drains. */
    exploring(worker: WorkerScope = ALL_NODES): string | undefined {
        return this.currentNodes.get(worker.id);
    }

    /**
     * Whether a worker has finished its slice: nothing left in its queue and
     * nothing mid-exploration. This is scoped to the worker on purpose - other
     * workers' queued nodes are theirs to drain, not a reason to hold this one
     * open - and it is the condition the generator's finish tool gates on, so a
     * worker terminates the moment its own slice is done instead of spinning
     * next_node against the whole run's queue.
     */
    hasDrained(worker: WorkerScope = ALL_NODES): boolean {
        return this.remainingFor(worker) === 0 && this.exploring(worker) == null;
    }

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

    /**
     * Hand out the next node, closing off whatever the same worker was exploring.
     *
     * `worker` scopes both the queue and the "what am I on" bookkeeping, so
     * several agents can walk the graph at once without stealing each other's
     * nodes or marking each other's work skipped. The default worker is the whole
     * graph, which is the sequential run.
     */
    nextNode(worker: WorkerScope = ALL_NODES): { node: FeatureNode; remaining: number } | undefined {
        const previous = this.currentNodes.get(worker.id);
        if (previous != null) {
            const current = this.nodes.get(previous);
            if (current && current.status !== "tested") {
                current.status = "skipped";
                this.reportProgress();
            }
            this.currentNodes.delete(worker.id);
        }

        // Scan rather than shift: another worker's nodes stay in the queue for it
        // to take, so this one steps past them instead of consuming them.
        const mine = this.queue.filter((id) => worker.owns(id));
        for (const id of mine) {
            const node = this.nodes.get(id);
            if (!node || node.status === "tested" || node.status === "skipped") continue;
            if (node.status === "exploring") continue;

            this.queue = this.queue.filter((queued) => queued !== id);
            node.status = "exploring";
            this.currentNodes.set(worker.id, id);
            return { node, remaining: this.queue.filter((queued) => worker.owns(queued)).length };
        }

        this.currentNodes.delete(worker.id);
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

        // Any worker's in-progress node will do: a write that names no known node
        // and matches no written test still belongs to something being explored,
        // and with one worker this is exactly the old behaviour.
        for (const nodeId of this.currentNodes.values()) {
            if (this.nodes.has(nodeId)) return nodeId;
        }
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

    /**
     * Report the review pass as its own sub-progress, distinct from node
     * exploration. The step strip already shows "13/13 nodes" once generation
     * finishes; this replaces it with "Review 4/10" so the run does not look
     * done while the longest silent phase is still ahead.
     *
     * `done`/`total` count the tests reviewed this cycle. `startedAt` lets the
     * ETA bridge the gap before the first completion arrives.
     */
    setReviewProgress(done: number, total: number, startedAt: number): void {
        if (!this.reportsProgress) return;
        const note = this.phase;
        reportSubProgress("testGenerator", done, total, "reviewed", note, startedAt);
    }

    /**
     * The review pass is over: restore the node-exploration sub-progress on the
     * strip, and settle the per-test rows so nothing is left claiming to be
     * under review or awaiting a fix that the budget cut off.
     */
    clearReviewProgress(): void {
        this.reportProgress();
        getActiveStore()?.settleReviews();
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
            currentNode: [...this.currentNodes.values()][0],
            testsWritten: Object.fromEntries(this.testsWritten),
        };
    }

    static deserialize(data: SerializedCoverageState, options: CoverageStateOptions = {}): CoverageState {
        const state = new CoverageState(options);
        state.nodes = new Map(Object.entries(data.nodes));
        state.queue = data.queue;
        if (data.currentNode != null) state.currentNodes.set(DEFAULT_WORKER_ID, data.currentNode);
        state.testsWritten = new Map(Object.entries(data.testsWritten));
        return state;
    }
}

/**
 * Persist the graph, one write at a time.
 *
 * Every write_test saves the state, so with several generator agents running the
 * writes overlap - and two `writeFile` calls to the same path can interleave into
 * a file that parses as neither. Chained per path so a save always reflects a
 * whole snapshot, and so the last one to start is the last one to land.
 */
const saveQueues = new Map<string, Promise<unknown>>();

export async function saveBfsState(outputDir: string, state: CoverageState): Promise<void> {
    const path = join(outputDir, state.stateFile);
    const previous = saveQueues.get(path) ?? Promise.resolve();
    const write = previous
        .catch(() => undefined)
        .then(() => writeFile(path, JSON.stringify(state.serialize(), null, 2), "utf-8"));
    saveQueues.set(path, write);
    await write;
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
