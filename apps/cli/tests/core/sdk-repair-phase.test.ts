import { describe, expect, test, vi } from "vitest";

vi.mock("../../src/ui/prompts", () => ({
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

import type { AgentLauncher, KillableProcess } from "../../src/core/coding-agent";
import { runSdkRepairPhase, watchForSdkRepair, type SdkReadiness } from "../../src/core/sdk-repair-phase";

const APP_ID = "app_1";
const TIMING = { pollMs: 1, graceMs: 1, killMs: 1 };

/** Successive answers from `getOnboardingState`; the last repeats. */
function fakeClient(states: SdkReadiness[]) {
    let index = 0;
    const pairings: string[] = [];
    return {
        pairings,
        getOnboardingState: () => {
            const state = states[Math.min(index, states.length - 1)]!;
            index++;
            return Promise.resolve(state);
        },
        createAgentPairing: (applicationId: string) => {
            pairings.push(applicationId);
            return Promise.resolve("ABCD2345");
        },
    };
}

function fakeLauncher(onLaunch?: (message: string) => void): AgentLauncher {
    return {
        id: "claude",
        label: "Claude Code",
        isAvailable: () => Promise.resolve(true),
        registerMcpServer: () => Promise.resolve({ env: {} }),
        launch: (request) => {
            onLaunch?.(request.message);
            return Promise.resolve(0);
        },
    };
}

function deps(client: ReturnType<typeof fakeClient>, launcher = fakeLauncher()) {
    return {
        client,
        applicationId: APP_ID,
        launcher,
        permissionMode: "bypassPermissions" as const,
        mcpUrl: "https://api.example.test/v1/mcp",
        interactive: false,
        timing: TIMING,
    };
}

const DONE: SdkReadiness = { sdkConfigured: true, dryRunPassed: true };
const NOTHING: SdkReadiness = { sdkConfigured: false, dryRunPassed: false };
const HALF: SdkReadiness = { sdkConfigured: true, dryRunPassed: false };

describe("runSdkRepairPhase", () => {
    // The CLI tries the two calls itself first. When they worked there is nothing for
    // an agent to fix, and spawning one would cost minutes to confirm what is already
    // true.
    test("does not hand off when both are already good", async () => {
        const client = fakeClient([DONE]);
        let launched = false;

        const outcome = await runSdkRepairPhase(
            deps(
                client,
                fakeLauncher(() => (launched = true)),
            ),
        );

        expect(outcome).toEqual({ kind: "passed" });
        expect(launched).toBe(false);
        expect(client.pairings).toEqual([]);
    });

    // Half-done is still not done - an SDK that answers with no scenario that
    // provisions cannot run a test.
    test("hands off when only one of the two is good", async () => {
        const client = fakeClient([HALF, DONE]);

        const outcome = await runSdkRepairPhase(deps(client));

        expect(outcome).toEqual({ kind: "passed" });
        expect(client.pairings).toEqual([APP_ID]);
    });

    // Read from the platform, never from the agent: an agent's account of whether an
    // endpoint answers is not evidence that it does.
    test("reports incomplete when the agent stops with work outstanding", async () => {
        const client = fakeClient([NOTHING, HALF]);

        const outcome = await runSdkRepairPhase(deps(client));

        expect(outcome).toEqual({ kind: "incomplete", sdkConfigured: true, dryRunPassed: false });
    });

    test("names the MCP server and its code in the prompt it hands over", async () => {
        const client = fakeClient([NOTHING, DONE]);
        let message = "";

        await runSdkRepairPhase(
            deps(
                client,
                fakeLauncher((m) => (message = m)),
            ),
        );

        expect(message).toContain("autonoma");
        expect(message).toContain("ABCD2345");
        // Headless: the agent has nobody to ask, and "I tried" is not "I am done".
        expect(message).toContain("Never report success you have not confirmed");
    });
});

describe("watchForSdkRepair", () => {
    test("terminates the agent once the platform reports both good", async () => {
        const client = fakeClient([DONE]);
        const signals: string[] = [];
        const proc: KillableProcess = {
            kill: (signal) => {
                signals.push(signal);
                return true;
            },
        };

        const cleanup = watchForSdkRepair(client, APP_ID, proc, TIMING);
        await vi.waitFor(() => expect(signals).toContain("SIGTERM"));
        cleanup();
    });

    // A dropped tick must not kill a working session; the next tick answers anyway.
    test("keeps polling when a read fails", async () => {
        let calls = 0;
        const client = {
            getOnboardingState: () => {
                calls++;
                return calls === 1 ? Promise.reject(new Error("network")) : Promise.resolve(DONE);
            },
        };
        const signals: string[] = [];
        const proc: KillableProcess = {
            kill: (signal) => {
                signals.push(signal);
                return true;
            },
        };

        const cleanup = watchForSdkRepair(client, APP_ID, proc, TIMING);
        await vi.waitFor(() => expect(signals).toContain("SIGTERM"));
        cleanup();
    });
});
