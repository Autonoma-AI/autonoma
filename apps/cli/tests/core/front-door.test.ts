import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AppConfig } from "../../src/config";
import { planFrontDoor } from "../../src/core/front-door";

const API_URL = "https://api.example.test";

/** The onboarding fields `resolveEntryPhase` reads, per phase we want to land in. */
const STATE_BY_PHASE = {
    preview: { step: "previewkit_deploying", artifactsUploaded: false, sdkConfigured: false, dryRunPassed: false },
    planner: { step: "completed", artifactsUploaded: false, sdkConfigured: false, dryRunPassed: false },
    dryRun: { step: "completed", artifactsUploaded: true, sdkConfigured: true, dryRunPassed: false },
    done: { step: "completed", artifactsUploaded: true, sdkConfigured: true, dryRunPassed: true },
} as const;

let calls: string[] = [];
/** Procedures that should answer with an error instead of a result. */
let failing: ReadonlySet<string> = new Set();

function config(): AppConfig {
    return {
        projectRoot: "/tmp/project",
        projectSlug: "acme-web",
        autonomaApiUrl: API_URL,
        autonomaApiToken: "ask_test",
        autonomaApplicationId: "app_1",
    };
}

function stubApi(phase: keyof typeof STATE_BY_PHASE): void {
    vi.stubGlobal("fetch", (url: string | URL) => {
        const procedure = new URL(url.toString()).pathname.replace("/v1/trpc/", "");
        calls.push(procedure);
        if (failing.has(procedure)) {
            return Promise.resolve(
                new Response(JSON.stringify({ error: { json: { message: "Nope", code: -32603 } } }), {
                    status: 500,
                    headers: { "Content-Type": "application/json" },
                }),
            );
        }
        const data = procedure === "onboarding.getState" ? STATE_BY_PHASE[phase] : {};
        return Promise.resolve(
            new Response(JSON.stringify({ result: { data: { json: data } } }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            }),
        );
    });
}

beforeEach(() => {
    calls = [];
    failing = new Set();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("planFrontDoor", () => {
    test("runs standalone when the repo is not linked to an application", async () => {
        stubApi("planner");

        const plan = await planFrontDoor({ ...config(), autonomaApplicationId: undefined });

        expect(plan).toBeUndefined();
        expect(calls).toEqual([]);
    });

    // The claim is what puts the web app on "continue in your terminal" instead of
    // offering the user the very steps this run is doing.
    test.each(["planner", "dryRun"] as const)("claims the config for a %s run", async (phase) => {
        stubApi(phase);

        const plan = await planFrontDoor(config());

        expect(plan?.phase).toBe(phase);
        expect(calls).toContain("onboarding.resumeAgent");
    });

    // Pairing takes the mutex here, with a connected agent behind it to feed the
    // activity screen. Claiming ahead of that would render that screen empty.
    test("leaves the config alone when the run opens on the preview phase", async () => {
        stubApi("preview");

        const plan = await planFrontDoor(config());

        expect(plan?.phase).toBe("preview");
        expect(calls).not.toContain("onboarding.resumeAgent");
    });

    test("leaves the config alone when there is nothing left to do", async () => {
        stubApi("done");

        const plan = await planFrontDoor(config());

        expect(plan?.phase).toBe("done");
        expect(calls).not.toContain("onboarding.resumeAgent");
    });

    // What a web page renders is never worth ending a run over.
    test("still plans the run when the claim fails", async () => {
        stubApi("planner");
        failing = new Set(["onboarding.resumeAgent"]);

        const plan = await planFrontDoor(config());

        expect(plan?.phase).toBe("planner");
        expect(calls).toContain("onboarding.resumeAgent");
    });
});
