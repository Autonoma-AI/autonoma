import { afterEach, describe, expect, it, vi } from "vitest";
import { queryLokiLogs } from "../../src/logs/loki";

describe("queryLokiLogs", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("flattens log lines across Loki streams and builds the right query URL", async () => {
        const lokiBody = {
            data: {
                result: [
                    {
                        values: [
                            ["1690000000000000000", "line A"],
                            ["1690000000000000001", "line B"],
                        ],
                    },
                    { values: [["1690000000000000002", "line C"]] },
                ],
            },
        };
        const fetchMock = vi.fn(async (_url: string | URL) => new Response(JSON.stringify(lokiBody), { status: 200 }));
        vi.stubGlobal("fetch", fetchMock);

        const lines = await queryLokiLogs({
            lokiBaseUrl: "http://loki:3100",
            namespace: "preview-ns",
            startEpoch: 1000,
            endEpoch: 2000,
            regex: "error",
        });

        expect(lines).toEqual(["line A", "line B", "line C"]);
        const requested = new URL(String(fetchMock.mock.calls[0]?.[0]));
        expect(requested.pathname).toBe("/loki/api/v1/query_range");
        expect(requested.searchParams.get("query")).toBe('{namespace="preview-ns"} |~ `error`');
        expect(requested.searchParams.get("limit")).toBe("150");
    });

    it("throws a clear error when the network call fails (fetch failed)", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                throw new Error("fetch failed");
            }),
        );
        await expect(
            queryLokiLogs({ lokiBaseUrl: "http://loki", namespace: "ns", startEpoch: 1, endEpoch: 2, regex: "x" }),
        ).rejects.toThrow(/Loki request failed: fetch failed/);
    });

    it("throws on a non-200 response", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response("unavailable", { status: 503 })),
        );
        await expect(
            queryLokiLogs({ lokiBaseUrl: "http://loki", namespace: "ns", startEpoch: 1, endEpoch: 2, regex: "x" }),
        ).rejects.toThrow(/HTTP 503/);
    });
});
