import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../src/ui/prompts", () => ({
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

import type { AgentLauncher, LaunchRequest, McpServerSpec } from "../../src/core/coding-agent";
import { runPreviewPhase, watchForPreviewPhase, type OnboardingReader } from "../../src/core/preview-phase";

const TIMING = { pollMs: 5, graceMs: 10, killMs: 5000 };
const APP_ID = "app_1";
const MCP_URL = "https://api.example.test/v1/mcp";

interface FakeClient {
    client: OnboardingReader;
    stateReads: number;
    pairings: number;
}

/** A client whose reported step can change mid-run, the way a real deploy does. */
function fakeClient(steps: string[]): FakeClient {
    const queue = [...steps];
    let last = queue[0] ?? "github";
    const fake = {
        stateReads: 0,
        pairings: 0,
        client: {
            getOnboardingState: () => {
                fake.stateReads++;
                last = queue.length > 1 ? (queue.shift() ?? last) : (queue[0] ?? last);
                return Promise.resolve({ step: last });
            },
            refreshPreviewReadiness: () => Promise.resolve(),
            createAgentPairing: () => {
                fake.pairings++;
                return Promise.resolve("ABCD2345");
            },
        },
    };
    return fake;
}

interface FakeLauncher {
    launcher: AgentLauncher;
    registrations: McpServerSpec[];
    launches: LaunchRequest[];
}

function fakeLauncher(registrationEnv: Record<string, string> = {}): FakeLauncher {
    const registrations: McpServerSpec[] = [];
    const launches: LaunchRequest[] = [];
    return {
        registrations,
        launches,
        launcher: {
            id: "fake",
            label: "Fake Agent",
            isAvailable: () => Promise.resolve(true),
            registerMcpServer: (spec) => {
                registrations.push(spec);
                return Promise.resolve({ env: registrationEnv });
            },
            launch: (request) => {
                launches.push(request);
                return Promise.resolve(0);
            },
        },
    };
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe("runPreviewPhase", () => {
    // The registration has to happen before the spawn: a client only loads its server
    // list at startup, so a session can never pick up a server registered after it.
    test("registers the MCP server before it launches the agent", async () => {
        const client = fakeClient(["preview_verified"]);
        const agent = fakeLauncher();

        await runPreviewPhase({
            client: client.client,
            applicationId: APP_ID,
            launcher: agent.launcher,
            permissionMode: "bypassPermissions",
            mcpUrl: MCP_URL,
            interactive: true,
            timing: TIMING,
        });

        expect(agent.registrations).toEqual([
            { name: "autonoma", url: MCP_URL, apiToken: undefined, browserSignIn: true },
        ]);
        expect(agent.launches).toHaveLength(1);
    });

    test("mints a fresh pairing code and names the server literally in the prompt", async () => {
        const client = fakeClient(["preview_verified"]);
        const agent = fakeLauncher();

        await runPreviewPhase({
            client: client.client,
            applicationId: APP_ID,
            launcher: agent.launcher,
            permissionMode: "bypassPermissions",
            mcpUrl: MCP_URL,
            interactive: true,
            timing: TIMING,
        });

        expect(client.pairings).toBe(1);
        // Word for word what the web app hands out for this job. That wording is the
        // one people have validated by running it themselves, and an interactive run
        // here is the same act with the registration and the code done for them - so
        // this asserts equality, not a prefix. "the Autonoma MCP" would also be
        // ambiguous to an agent holding several servers.
        expect(agent.launches[0]?.message).toBe("set up my preview environments with the autonoma MCP, code ABCD2345");
    });

    // Headless runs use print mode, where asking a question IS ending the turn. Both
    // early exits seen in practice - stopping to ask, and calling "I tried" done -
    // have to be pre-empted in the prompt, because there is nobody to recover them.
    test("tells a headless agent what to do instead of asking, and when it is finished", async () => {
        const client = fakeClient(["preview_verified"]);
        const agent = fakeLauncher();

        await runPreviewPhase({
            client: client.client,
            applicationId: APP_ID,
            launcher: agent.launcher,
            permissionMode: "bypassPermissions",
            mcpUrl: MCP_URL,
            interactive: false,
            timing: TIMING,
        });

        const message = agent.launches[0]?.message ?? "";
        expect(message).toContain("set up my preview environments with the autonoma MCP, code ABCD2345");
        expect(message).toContain("no human to answer you");
        expect(message).toContain("finished when the preview is verified");
        expect(message).toContain("Never report success you have not confirmed");
    });

    // Reading readiness is what stamps a verified preview; the step alone only reports
    // what someone else stamped. Without this a good preview that comes up after the
    // agent stops polling is never noticed.
    test("refreshes readiness before it reads the step", async () => {
        const order: string[] = [];
        const client = {
            getOnboardingState: () => {
                order.push("state");
                return Promise.resolve({ step: "preview_verified" });
            },
            refreshPreviewReadiness: () => {
                order.push("readiness");
                return Promise.resolve();
            },
            createAgentPairing: () => Promise.resolve("ABCD2345"),
        };
        const agent = fakeLauncher();

        await runPreviewPhase({
            client,
            applicationId: APP_ID,
            launcher: agent.launcher,
            permissionMode: "bypassPermissions",
            mcpUrl: MCP_URL,
            interactive: false,
            timing: TIMING,
        });

        expect(order).toEqual(["readiness", "state"]);
    });

    // A readiness call that fails must not lose the step read behind it.
    test("still reads the step when the readiness refresh fails", async () => {
        const client = {
            getOnboardingState: () => Promise.resolve({ step: "preview_verified" }),
            refreshPreviewReadiness: () => Promise.reject(new Error("ECONNRESET")),
            createAgentPairing: () => Promise.resolve("ABCD2345"),
        };
        const agent = fakeLauncher();

        const outcome = await runPreviewPhase({
            client,
            applicationId: APP_ID,
            launcher: agent.launcher,
            permissionMode: "bypassPermissions",
            mcpUrl: MCP_URL,
            interactive: false,
            timing: TIMING,
        });

        expect(outcome).toEqual({ kind: "verified" });
    });

    test("carries the registration's env through to the spawned agent", async () => {
        const client = fakeClient(["preview_verified"]);
        const agent = fakeLauncher({ AUTONOMA_MCP_TOKEN: "ask_test" });

        await runPreviewPhase({
            client: client.client,
            applicationId: APP_ID,
            launcher: agent.launcher,
            permissionMode: "bypassPermissions",
            apiToken: "ask_test",
            mcpUrl: MCP_URL,
            interactive: false,
            timing: TIMING,
        });

        expect(agent.registrations[0]?.apiToken).toBe("ask_test");
        expect(agent.launches[0]?.env).toEqual({ AUTONOMA_MCP_TOKEN: "ask_test" });
    });

    // A browser sign-in is exactly what a headless run cannot do, and a token is
    // exactly what an interactive one should not need.
    test("passes a token only when there is no human to sign in", async () => {
        const client = fakeClient(["preview_verified"]);
        const agent = fakeLauncher();

        await runPreviewPhase({
            client: client.client,
            applicationId: APP_ID,
            launcher: agent.launcher,
            permissionMode: "bypassPermissions",
            apiToken: undefined,
            mcpUrl: MCP_URL,
            interactive: true,
            timing: TIMING,
        });

        expect(agent.registrations[0]?.apiToken).toBeUndefined();
        // Interactive sessions do not exit on their own, so they need a watcher.
        expect(agent.launches[0]?.watch).toBeTypeOf("function");
    });

    // A headless agent is no safer to wait on than an interactive one: observed
    // finishing the work and then continuing to potter, with the run blocked behind
    // it. Onboarding state ends the handoff in both modes.
    test("watches for completion headlessly too", async () => {
        const client = fakeClient(["preview_verified"]);
        const agent = fakeLauncher();

        await runPreviewPhase({
            client: client.client,
            applicationId: APP_ID,
            launcher: agent.launcher,
            permissionMode: "bypassPermissions",
            mcpUrl: MCP_URL,
            interactive: false,
            timing: TIMING,
        });

        expect(agent.launches[0]?.watch).toBeTypeOf("function");
    });

    test("reports verified once onboarding says the preview is up", async () => {
        const client = fakeClient(["preview_verified"]);
        const agent = fakeLauncher();

        const outcome = await runPreviewPhase({
            client: client.client,
            applicationId: APP_ID,
            launcher: agent.launcher,
            permissionMode: "bypassPermissions",
            mcpUrl: MCP_URL,
            interactive: false,
            timing: TIMING,
        });

        expect(outcome).toEqual({ kind: "verified" });
    });

    // The agent's exit code says nothing about whether a preview deployed, so the
    // step is the only thing that decides this.
    test("reports incomplete when the agent exits with the preview unconfirmed", async () => {
        const client = fakeClient(["previewkit_configuring"]);
        const agent = fakeLauncher();

        const outcome = await runPreviewPhase({
            client: client.client,
            applicationId: APP_ID,
            launcher: agent.launcher,
            permissionMode: "bypassPermissions",
            mcpUrl: MCP_URL,
            interactive: false,
            timing: TIMING,
        });

        expect(outcome).toEqual({ kind: "incomplete", step: "previewkit_configuring" });
    });

    // Every preview path advances the step in its own way, so anything at or past
    // preview_verified counts - including an app the agent took all the way live.
    test("treats a fully live app as verified", async () => {
        const client = fakeClient(["completed"]);
        const agent = fakeLauncher();

        const outcome = await runPreviewPhase({
            client: client.client,
            applicationId: APP_ID,
            launcher: agent.launcher,
            permissionMode: "bypassPermissions",
            mcpUrl: MCP_URL,
            interactive: false,
            timing: TIMING,
        });

        expect(outcome).toEqual({ kind: "verified" });
    });
});

describe("watchForPreviewPhase", () => {
    let kill: (signal: NodeJS.Signals) => boolean;
    let killed: NodeJS.Signals[];

    beforeEach(() => {
        killed = [];
        kill = (signal: NodeJS.Signals) => {
            killed.push(signal);
            return true;
        };
    });

    test("reclaims the terminal once the preview is verified", async () => {
        const client = fakeClient(["previewkit_deploying", "preview_verified"]);

        const stop = watchForPreviewPhase(client.client, APP_ID, { kill }, TIMING);
        await vi.waitFor(() => expect(killed).toContain("SIGTERM"), { timeout: 2000 });
        stop();
    });

    test("leaves a working agent alone while the preview is still building", async () => {
        const client = fakeClient(["previewkit_deploying"]);

        const stop = watchForPreviewPhase(client.client, APP_ID, { kill }, TIMING);
        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(killed).toEqual([]);
        stop();
    });

    // One dropped request must not kill a session that is working fine; the next
    // tick answers anyway.
    test("survives a failed poll", async () => {
        let calls = 0;
        const flaky = {
            refreshPreviewReadiness: () => Promise.resolve(),
            getOnboardingState: () => {
                calls++;
                if (calls === 1) return Promise.reject(new Error("ECONNRESET"));
                return Promise.resolve({ step: "preview_verified" });
            },
        };

        const stop = watchForPreviewPhase(flaky, APP_ID, { kill }, TIMING);
        await vi.waitFor(() => expect(killed).toContain("SIGTERM"), { timeout: 2000 });
        stop();
    });

    test("cleanup stops a pending reclaim (the agent exited on its own)", async () => {
        const client = fakeClient(["preview_verified"]);

        const stop = watchForPreviewPhase(client.client, APP_ID, { kill }, { ...TIMING, graceMs: 60 });
        await new Promise((resolve) => setTimeout(resolve, 30));
        stop();
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(killed).toEqual([]);
    });
});
