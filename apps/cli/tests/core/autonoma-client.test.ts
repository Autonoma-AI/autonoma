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

    test("reads the dry-run targets from the onboarding router", async () => {
        respond = () => trpcOk({ targets: [{ id: "pr-7" }], autoDetectedTargetId: "pr-7" });

        const targets = await client().listDryRunTargets("app_1");

        expect(targets.autoDetectedTargetId).toBe("pr-7");
        const url = new URL(requests[0]?.url ?? "");
        expect(url.pathname).toBe("/v1/trpc/onboarding.listSdkDryRunTargets");
    });

    // The scenarios come from their own router, not from onboarding - a dry run needs
    // both, and they are two different mounts.
    test("reads the scenarios from the scenarios router", async () => {
        respond = () => trpcOk([{ id: "sc_1", name: "logged-in admin" }]);

        const scenarios = await client().listScenarios("app_1");

        expect(scenarios).toEqual([{ id: "sc_1", name: "logged-in admin" }]);
        const url = new URL(requests[0]?.url ?? "");
        expect(url.pathname).toBe("/v1/trpc/scenarios.list");
    });

    test("points a dry run at the target it was given", async () => {
        respond = () => trpcOk({ success: true, phase: "down" });

        const result = await client().runScenarioDryRun("app_1", "sc_1", "pr-7");

        expect(result.success).toBe(true);
        expect(requests[0]?.method).toBe("POST");
        expect(requests[0]?.url).toBe(`${API_URL}/v1/trpc/onboarding.runScenarioDryRun`);
        expect(JSON.parse(requests[0]?.body ?? "")).toEqual({
            json: { applicationId: "app_1", scenarioId: "sc_1", targetId: "pr-7" },
        });
    });

    test("carries the self-heal decision through to discovery", async () => {
        respond = () => trpcOk({ status: "discovered" });

        await client().configureAndDiscoverSdkTarget("app_1", "pr-7", false);

        expect(JSON.parse(requests[0]?.body ?? "")).toEqual({
            json: { applicationId: "app_1", targetId: "pr-7", allowSelfHeal: false },
        });
    });

    test("claims the config through the same mutation the UI's hand-back control uses", async () => {
        await client().claimAgentHold("app_1");

        const request = requests[0];
        expect(request?.method).toBe("POST");
        expect(request?.url).toBe(`${API_URL}/v1/trpc/onboarding.resumeAgent`);
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
