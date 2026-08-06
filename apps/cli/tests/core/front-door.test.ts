import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../src/ui/prompts", () => ({
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

import type { AppConfig } from "../../src/config";
import type { AutonomaClient } from "../../src/core/autonoma-client";
import type { AgentLauncher } from "../../src/core/coding-agent";
import { describeIncompletePreview, planFrontDoor, runPreviewHandoff } from "../../src/core/front-door";

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

function launcher(id: string, available: boolean): AgentLauncher {
    return {
        id,
        label: `Agent ${id}`,
        isAvailable: () => Promise.resolve(available),
        registerMcpServer: () => Promise.resolve({ env: {} }),
        launch: () => Promise.resolve(0),
    };
}

function config(): AppConfig {
    return {
        projectRoot: "/tmp/project",
        projectSlug: "acme-web",
        autonomaApiUrl: API_URL,
        autonomaApiToken: "ask_test",
        autonomaApplicationId: "app_1",
    };
}

function plan() {
    // The handoff never reaches the client on the paths under test - it gives up
    // before it has an agent to hand anything to.
    const client = {} as AutonomaClient;
    return { client, applicationId: "app_1", phase: "preview" as const };
}

/**
 * The calls the preview phase and the go-live step make, and nothing else. Reports
 * the preview already verified so the phase returns rather than polling.
 */
function previewClient({ failTakeLive = false } = {}) {
    const takeLiveCalls: string[] = [];
    return {
        takeLiveCalls,
        createAgentPairing: () => Promise.resolve("ABCD2345"),
        refreshPreviewReadiness: () => Promise.resolve(),
        getOnboardingState: () =>
            Promise.resolve({ step: "preview_verified", sdkConfigured: false, dryRunPassed: false }),
        takeAppLive: (applicationId: string) => {
            takeLiveCalls.push(applicationId);
            return failTakeLive
                ? Promise.reject(new Error("network"))
                : Promise.resolve({ alreadyLive: false, step: "completed" });
        },
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

describe("runPreviewHandoff", () => {
    test("reports no agent when none is installed", async () => {
        const result = await runPreviewHandoff({
            plan: plan(),
            config: config(),
            nonInteractive: true,
            launchers: [launcher("claude", false), launcher("codex", false)],
        });

        expect(result).toEqual({ kind: "no-agent" });
    });

    // The regression this exists for: the preview phase stops the agent the moment the
    // platform reports the preview verified, which is the moment the agent would have
    // gone live. Left to the agent, a run finished every step with the app still not
    // being reviewed.
    test("takes the app live once the preview is verified", async () => {
        stubApi("preview");
        const client = previewClient();

        const result = await runPreviewHandoff({
            plan: { client, applicationId: "app_1" },
            config: config(),
            nonInteractive: true,
            launchers: [launcher("claude", true)],
        });

        expect(result.kind).toBe("verified");
        expect(client.takeLiveCalls).toEqual(["app_1"]);
    });

    // Going live is the last thing a run does and the least of what it produced. A
    // network blip there must not lose the suite the run just generated.
    test("does not fail the run when going live does", async () => {
        stubApi("preview");
        const client = previewClient({ failTakeLive: true });

        const result = await runPreviewHandoff({
            plan: { client, applicationId: "app_1" },
            config: config(),
            nonInteractive: true,
            launchers: [launcher("claude", true)],
        });

        expect(result.kind).toBe("verified");
    });
});

describe("describeIncompletePreview", () => {
    test("says nothing when the preview is up", () => {
        expect(describeIncompletePreview({ kind: "verified" })).toBeUndefined();
    });

    test("tells a caller with none to install one", () => {
        const message = describeIncompletePreview({ kind: "no-agent" }) ?? "";

        expect(message).toContain("Install Claude Code or the Codex CLI");
    });

    test("explains what an unverified preview costs, without making it fatal", () => {
        const message = describeIncompletePreview({ kind: "incomplete", step: "previewkit_deploying" }) ?? "";

        expect(message).toContain("dry runs");
        expect(message).toContain("the rest of the run continues");
    });
});
