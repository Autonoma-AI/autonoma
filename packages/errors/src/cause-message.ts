/**
 * The human-readable message of a thrown value.
 *
 * Non-`Error` throws (a string, an object) stringify rather than being dropped, so a caller embedding this in
 * its own message is never left saying something failed with no reason at all. The idiom it replaces -
 * `err instanceof Error ? err.message : String(err)` - is written inline in ~100 places across this repo;
 * prefer importing this one.
 */
export function causeMessage(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
}
