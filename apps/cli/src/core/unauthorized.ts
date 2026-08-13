// The API's tRPC layer rejects an unusable credential with a TRPCError the client
// re-throws carrying `data.code` / `data.httpStatus`. Nothing else in that shape is
// worth reading, so match on the two fields rather than the client's error class -
// which would pull @trpc/client into a module that has no other use for it.
const REJECTED_CODES: ReadonlySet<unknown> = new Set(["UNAUTHORIZED", "FORBIDDEN"]);
const REJECTED_STATUSES: ReadonlySet<unknown> = new Set([401, 403]);

// A rejection that never reached tRPC - an edge or middleware answering first - has
// no structured code, only a body. Narrow enough that a working call cannot say it.
const REJECTED_MESSAGE = /\bunauthorized\b|\bforbidden\b|\bneeds a credential\b/i;

/**
 * True when the Autonoma API refused the run's credential, as opposed to failing
 * for any other reason.
 *
 * The distinction decides whether a run continues. Autonoma being briefly
 * unreadable is not worth failing a run that would otherwise work, so those
 * degrade; a refused credential is different in kind, because every later call
 * fails the same way and none of them can say why (see `isPlaceholderCredential`).
 */
export function isUnauthorizedResponse(err: unknown): boolean {
    if (!(err instanceof Error)) return false;

    if ("data" in err && typeof err.data === "object" && err.data !== null) {
        const { data } = err;
        if ("code" in data && REJECTED_CODES.has(data.code)) return true;
        if ("httpStatus" in data && REJECTED_STATUSES.has(data.httpStatus)) return true;
    }

    return REJECTED_MESSAGE.test(err.message);
}
