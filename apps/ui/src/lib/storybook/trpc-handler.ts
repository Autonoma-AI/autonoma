import type { RouterOutputs } from "lib/trpc";
import { HttpResponse, http } from "msw";
import superjson from "superjson";

/**
 * A tRPC fixture tree mirrors the router structure: one optional key per
 * router, one optional key per procedure. A procedure's value is its FULL
 * output type, so fixtures typecheck against the real API and rot loudly
 * when a router output changes.
 */
export type TrpcFixtures = {
    [R in keyof RouterOutputs]?: { [P in keyof RouterOutputs[R]]?: RouterOutputs[R][P] };
};

/**
 * MSW handler answering every tRPC HTTP request (httpBatchLink and httpLink,
 * GET queries and POST mutations) from the fixture tree. Inputs are ignored
 * on purpose - a story fixture pins one response per procedure. Unmocked
 * procedures return a tRPC error and log a `[storybook-fixtures]` console
 * error so missing mocks are loud in the story and in screenshot runs.
 */
export function trpcHandler(fixtures: TrpcFixtures) {
    return http.all("*/v1/trpc/*", ({ request }) => {
        const url = new URL(request.url);
        const trpcPath = url.pathname.replace(/^.*\/v1\/trpc\//, "");
        const procedures = trpcPath.split(",").filter((p) => p.length > 0);
        const isBatch = url.searchParams.get("batch") === "1";

        const results = procedures.map((procedure) => resolveProcedure(fixtures, procedure));
        return HttpResponse.json(isBatch ? results : results[0]);
    });
}

interface TrpcResponseEnvelope {
    result?: { data: ReturnType<typeof superjson.serialize> };
    error?: ReturnType<typeof superjson.serialize>;
}

function resolveProcedure(fixtures: TrpcFixtures, procedure: string): TrpcResponseEnvelope {
    const resolution = walkFixtureTree(fixtures, procedure.split("."));
    if (!resolution.found) {
        console.error(`[storybook-fixtures] no fixture for tRPC procedure "${procedure}"`);
        // The whole envelope value is transformer-encoded, exactly like the
        // real server does - a raw error object breaks the client's superjson
        // deserialize with "Unable to transform response from server".
        return {
            error: superjson.serialize({
                message: `No fixture for tRPC procedure "${procedure}"`,
                code: -32603,
                data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500, path: procedure },
            }),
        };
    }

    return { result: { data: superjson.serialize(resolution.value) } };
}

interface FixtureResolution {
    found: boolean;
    value?: unknown;
}

/**
 * Walks the fixture tree along the procedure's dotted path. The full path is
 * always consumed, so a procedure output that happens to be an object can
 * never be confused with a nested router.
 */
function walkFixtureTree(tree: object, segments: string[]): FixtureResolution {
    let node: unknown = tree;
    for (const segment of segments) {
        if (node == null || typeof node !== "object" || !(segment in node)) {
            return { found: false };
        }
        node = Reflect.get(node, segment);
    }
    return { found: true, value: node };
}
