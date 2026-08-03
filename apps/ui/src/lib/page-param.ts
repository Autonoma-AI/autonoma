/**
 * Reads a page number out of a URL search param.
 *
 * A hand-edited or stale `?page=` is untrusted input: anything that is not a whole page number reads as the
 * first page. There is deliberately no upper bound here - the client does not know how many pages exist, and
 * guessing would fight the server, which clamps an over-run page to the last one and reports back the page it
 * actually served. Read that value for the pager, not this one.
 */
export function toPageParam(value: unknown): number {
    const page = Number(value);
    return Number.isInteger(page) && page >= 1 ? page : 1;
}
