import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { reportSubProgress } from "../../core/progress";

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

export class CoverageState {
    nodes: Map<string, FeatureNode> = new Map();
    queue: string[] = [];
    testsWritten: Map<string, string[]> = new Map();
    currentNode?: string;

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

    markTested(nodeId: string, testPaths: string[]): void {
        const node = this.nodes.get(nodeId);
        if (node) node.status = "tested";
        this.currentNode = undefined;
        const existing = this.testsWritten.get(nodeId) ?? [];
        this.testsWritten.set(nodeId, [...existing, ...testPaths]);
        this.reportProgress();
    }

    allTestPaths(): string[] {
        const paths: string[] = [];
        for (const tests of this.testsWritten.values()) {
            paths.push(...tests);
        }
        return paths;
    }

    /** Processed nodes (tested or skipped) over the known graph size, plus a
     * live estimate of the final test count - which isn't known upfront (each
     * node's test count is decided as its source is read). */
    private reportProgress(): void {
        const stats = this.summary();
        const processed = stats.tested + stats.skipped;
        const expected = estimateExpectedTests(stats.totalTests, processed, stats.totalNodes);
        reportSubProgress("testGenerator", processed, stats.totalNodes, "nodes", `~${expected} tests`);
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

    static deserialize(data: SerializedCoverageState): CoverageState {
        const state = new CoverageState();
        state.nodes = new Map(Object.entries(data.nodes));
        state.queue = data.queue;
        state.currentNode = data.currentNode ?? undefined;
        state.testsWritten = new Map(Object.entries(data.testsWritten));
        return state;
    }
}

const STATE_FILE = ".bfs-state.json";

export async function saveBfsState(outputDir: string, state: CoverageState): Promise<void> {
    const path = join(outputDir, STATE_FILE);
    await writeFile(path, JSON.stringify(state.serialize(), null, 2), "utf-8");
}

export async function loadBfsState(outputDir: string): Promise<CoverageState | undefined> {
    const path = join(outputDir, STATE_FILE);
    try {
        const raw = await readFile(path, "utf-8");
        return CoverageState.deserialize(JSON.parse(raw));
    } catch {
        return undefined;
    }
}
