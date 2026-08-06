/**
 * Run async work over a list with a fixed number of jobs in flight.
 *
 * Unlike batching (`for (chunk of chunks) await Promise.all(chunk)`), a slot is
 * refilled the moment its job settles, so one slow job delays only itself. A
 * batch instead waits for its slowest member and drains to idle before the next
 * one starts - on a fan-out whose jobs vary in length that costs most of the
 * parallelism you thought you had.
 */
export interface PoolOptions<T> {
    /** Maximum jobs in flight. Values below 1 are treated as 1. */
    limit: number;
    /**
     * Consulted before each job is dispatched. Return false to stop starting new
     * work; jobs already in flight are still awaited. Lets a caller enforce a
     * deadline without discarding work it has already paid for.
     */
    shouldContinue?: () => boolean;
    /**
     * Called after each job settles (completed or failed), with the number of
     * jobs that have settled and the total. A no-op by default; the review pass
     * uses it to report sub-progress so the dashboard does not sit at 99% while
     * 16 agents are still reading files.
     */
    onProgress?: (settled: number, total: number) => void;
    /**
     * Called with each item as its job is dispatched, before the work begins.
     * Lets a caller show what is in flight rather than only what has finished -
     * the review pass marks a test as under review the moment its first rubric
     * starts, instead of leaving the row idle until the slowest one lands.
     */
    onStart?: (item: T, index: number) => void;
}

export interface PoolOutcome<T, R> {
    /** Jobs that resolved, in completion order. */
    completed: { item: T; index: number; result: R }[];
    /** Jobs that threw. The pool keeps going; the caller decides what a failure means. */
    failed: { item: T; index: number; error: unknown }[];
    /** Items never dispatched because `shouldContinue` returned false. */
    skipped: T[];
}

export async function runPool<T, R>(
    items: readonly T[],
    { limit, shouldContinue, onProgress, onStart }: PoolOptions<T>,
    work: (item: T, index: number) => Promise<R>,
): Promise<PoolOutcome<T, R>> {
    const completed: PoolOutcome<T, R>["completed"] = [];
    const failed: PoolOutcome<T, R>["failed"] = [];
    const skipped: T[] = [];
    const inFlight = new Set<Promise<void>>();
    let next = 0;

    // A rejected job is recorded rather than rethrown: letting it escape would
    // abandon every other job still in flight, and their rejections would then
    // surface as unhandled.
    const total = items.length;
    const settled = { n: 0 };
    const fireProgress = () => onProgress?.(settled.n, total);
    const dispatch = (item: T, index: number): void => {
        onStart?.(item, index);
        const promise = work(item, index)
            .then((result) => {
                completed.push({ item, index, result });
            })
            .catch((error: unknown) => {
                failed.push({ item, index, error });
            })
            .finally(() => {
                inFlight.delete(promise);
                settled.n++;
                fireProgress();
            });
        inFlight.add(promise);
    };

    const cap = Math.max(1, limit);
    while (next < items.length) {
        if (shouldContinue != null && !shouldContinue()) {
            skipped.push(...items.slice(next));
            break;
        }
        while (inFlight.size < cap && next < items.length) {
            dispatch(items[next]!, next);
            next++;
        }
        // Wake as soon as ANY slot frees, not when the whole wave does.
        if (inFlight.size > 0) await Promise.race(inFlight);
    }

    await Promise.all(inFlight);
    return { completed, failed, skipped };
}
