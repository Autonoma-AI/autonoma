import { describe, expect, test } from "vitest";
import { isUnauthorizedResponse } from "../../src/core/unauthorized";

/** A TRPCClientError as the client re-throws it, without importing @trpc/client. */
function trpcError(data: Record<string, unknown>, message = "Something went wrong"): Error {
    return Object.assign(new Error(message), { data });
}

describe("a refused credential", () => {
    test("is recognized by the tRPC error code", () => {
        expect(isUnauthorizedResponse(trpcError({ code: "UNAUTHORIZED", httpStatus: 401 }))).toBe(true);
        expect(isUnauthorizedResponse(trpcError({ code: "FORBIDDEN", httpStatus: 403 }))).toBe(true);
    });

    test("is recognized by the status alone, for a code we do not map", () => {
        expect(isUnauthorizedResponse(trpcError({ code: "SOMETHING_NEW", httpStatus: 401 }))).toBe(true);
    });

    // Auth that answers before tRPC does - an edge, or the API's own middleware -
    // returns a body and no structured code.
    test("is recognized by the message when nothing structured survives", () => {
        expect(isUnauthorizedResponse(new Error('{"error":"unauthorized","resource":"Autonoma API"}'))).toBe(true);
        expect(isUnauthorizedResponse(new Error("This endpoint needs a credential."))).toBe(true);
    });
});

describe("everything else, which must not stop a run", () => {
    test.each([
        [trpcError({ code: "INTERNAL_SERVER_ERROR", httpStatus: 500 }), "the API failing"],
        [trpcError({ code: "NOT_FOUND", httpStatus: 404 }), "an app id we cannot read"],
        [trpcError({ code: "TIMEOUT", httpStatus: 408 }), "a slow API"],
        [new Error("fetch failed"), "the network"],
        ["not an error at all", "a non-error throw"],
    ])("passes through %#: %s", (err: unknown, _label: string) => {
        expect(isUnauthorizedResponse(err)).toBe(false);
    });
});
