/**
 * Run async work over a list with a fixed number of jobs in flight.
 *
 * Unlike batching (`for (chunk of chunks) await Promise.all(chunk)`), a slot is
 * refilled the moment its job settles, so one slow job delays only itself. A
 * batch instead waits for its slowest member and drains to idle before the next
 * one starts - on a fan-out whose jobs vary in length that costs most of the
 * parallelism you thought you had.
 */
export interface PoolOptions {
    /** Maximum jobs in flight. Values below 1 are treated as 1. */
    limit: number;
    /**
     * Consulted before each job is dispatched. Return false to stop starting new
     * work; jobs already in flight are still awaited. Lets a caller enforce a
     * deadline without discarding work it has already paid for.
     */
    shouldContinue?: () => boolean;
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
    { limit, shouldContinue }: PoolOptions,
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
    const dispatch = (item: T, index: number): void => {
        const promise = work(item, index)
            .then((result) => {
                completed.push({ item, index, result });
            })
            .catch((error: unknown) => {
                failed.push({ item, index, error });
            })
            .finally(() => {
                inFlight.delete(promise);
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
