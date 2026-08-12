import { getHeapStatistics } from "node:v8";

/**
 * Never exceed this, however much memory a machine has. Past here the limit stops
 * being memory and becomes the provider's rate limit and the usefulness of having
 * more agents chasing the same shrinking queue.
 */
const MAX_WORKERS = 16;

/** Below this, parallelism is not worth its coordination cost - but never zero. */
const MIN_WORKERS = 2;

/**
 * Heap a single generation worker should be assumed to hold.
 *
 * A worker is an agent conversation that accumulates every tool result it
 * receives - file reads capped at 256KB, bash output at 512KB, greps at 1MB -
 * and keeps them for the length of a chunk, alongside a researcher subagent it
 * may spawn and the review pass running beside it.
 */
const HEAP_PER_WORKER_MB = 250;

/**
 * Share of the heap ceiling that generation may claim. The rest is the review
 * pipeline, the node graph, the artifacts being written, and the headroom V8
 * needs to collect garbage without thrashing.
 */
const SAFE_HEAP_FRACTION = 0.5;

const MB = 1024 * 1024;

/**
 * How many generation workers this process can afford.
 *
 * Sized against V8's heap ceiling rather than the machine's RAM, because that
 * ceiling is what actually fails: a run died with "JavaScript heap out of memory"
 * at V8's 4.2GB default while the machine still had 12GB free. It is also the
 * only number that responds to --max-old-space-size, so an operator who raises
 * the ceiling gets more workers without touching this code.
 *
 * `os.freemem()` is deliberately not used. On macOS it counts the file cache as
 * used and reported 229MB on an idle 16GB machine, which would size every run
 * down to the floor.
 */
export function generationConcurrency(): number {
    const heapLimitMb = getHeapStatistics().heap_size_limit / MB;
    const affordable = Math.floor((heapLimitMb * SAFE_HEAP_FRACTION) / HEAP_PER_WORKER_MB);
    return Math.min(MAX_WORKERS, Math.max(MIN_WORKERS, affordable));
}

/** Human-readable sizing decision, for the run log. */
export function describeConcurrency(workers: number): string {
    const heapLimitMb = Math.round(getHeapStatistics().heap_size_limit / MB);
    const capped = workers === MAX_WORKERS ? ", capped" : "";
    return `${workers} workers (heap ceiling ${heapLimitMb}MB${capped})`;
}
