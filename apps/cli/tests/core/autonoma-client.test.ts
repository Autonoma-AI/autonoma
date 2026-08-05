import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AutonomaClient } from "../../src/core/autonoma-client";

const API_URL = "https://api.example.test";
const TOKEN = "ask_test";

interface RecordedRequest {
    url: string;
    method: string;
    authorization?: string;
    body?: string;
}

let requests: RecordedRequest[] = [];
let respond: () => Response;

/** A tRPC success body, in the envelope superjson's transformer produces. */
function trpcOk(data: unknown): Response {
    return new Response(JSON.stringify({ result: { data: { json: data } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
    });
}

beforeEach(() => {
    requests = [];
    respond = () => trpcOk({});
    vi.stubGlobal("fetch", (url: string | URL, init: RequestInit) => {
        const headers = new Headers(init.headers);
        requests.push({
            url: url.toString(),
            method: init.method ?? "GET",
            authorization: headers.get("Authorization") ?? undefined,
            body: typeof init.body === "string" ? init.body : undefined,
        });
        return Promise.resolve(respond());
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

function client(): AutonomaClient {
    return new AutonomaClient(API_URL, TOKEN);
}

// The wiring is what can be wrong here - the mount path, the credential, the
// transformer. The tRPC client itself is a dependency and is not this suite's job.
describe("AutonomaClient", () => {
    test("reads onboarding state from the tRPC mount with the API token", async () => {
        respond = () => trpcOk({ step: "preview_verified", sdkConfigured: false });

        const state = await client().getOnboardingState("app_1");

        expect(state.step).toBe("preview_verified");
        const request = requests[0];
        expect(request?.authorization).toBe(`Bearer ${TOKEN}`);
        const url = new URL(request?.url ?? "");
        expect(url.pathname).toBe("/v1/trpc/onboarding.getState");
        // superjson-wrapped, which is the transformer the API is configured with.
        expect(JSON.parse(url.searchParams.get("input") ?? "")).toEqual({ json: { applicationId: "app_1" } });
    });

    test("mints a pairing code and returns just the code", async () => {
        respond = () => trpcOk({ code: "ABCD2345", expiresAt: "2026-08-04T12:00:00.000Z" });

        const code = await client().createAgentPairing("app_1");

        expect(code).toBe("ABCD2345");
        const request = requests[0];
        expect(request?.method).toBe("POST");
        expect(request?.url).toBe(`${API_URL}/v1/trpc/onboarding.createAgentPairing`);
        expect(JSON.parse(request?.body ?? "")).toEqual({ json: { applicationId: "app_1" } });
    });

    test("surfaces an API error rather than resolving with nothing", async () => {
        respond = () =>
            new Response(JSON.stringify({ error: { json: { message: "Application not found", code: -32004 } } }), {
                status: 404,
                headers: { "Content-Type": "application/json" },
            });

        await expect(client().getOnboardingState("app_1")).rejects.toThrow(/Application not found/);
    });
});
