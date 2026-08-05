import { describe, expect, it } from "vitest";
import {
    AGENT_SESSION_STALE_AFTER_MS,
    isAgentDrivenApplication,
} from "../../../src/routes/onboarding/agent-session-liveness";

const NOW = new Date("2026-03-01T12:00:00Z").getTime();

function minutesAgo(minutes: number): Date {
    return new Date(NOW - minutes * 60_000);
}

describe("isAgentDrivenApplication", () => {
    it("is false for an application no agent has ever paired with", () => {
        const driven = isAgentDrivenApplication({ step: "previewkit_configuring" }, NOW);

        expect(driven).toBe(false);
    });

    it("is true while onboarding is unfinished, even after the agent has gone quiet", () => {
        // The UI has handed the form back by now, but the agent re-claims on its next write and
        // the user is still on the onboarding screen watching for it.
        const driven = isAgentDrivenApplication(
            {
                step: "previewkit_configuring",
                agentConnectedAt: minutesAgo(600),
                agentLastActivityAt: minutesAgo(180),
            },
            NOW,
        );

        expect(driven).toBe(true);
    });

    it("stays true after go-live while the agent is still working", () => {
        // The SDK handler and the scenario recipes are worked on after the app goes live, with
        // the user still watching the activity feed.
        const driven = isAgentDrivenApplication(
            { step: "completed", agentConnectedAt: minutesAgo(90), agentLastActivityAt: minutesAgo(2) },
            NOW,
        );

        expect(driven).toBe(true);
    });

    it("is false once a live application's agent session has gone quiet", () => {
        const idleMinutes = AGENT_SESSION_STALE_AFTER_MS / 60_000 + 1;
        const driven = isAgentDrivenApplication(
            {
                step: "completed",
                agentConnectedAt: minutesAgo(60 * 24 * 30),
                agentLastActivityAt: minutesAgo(idleMinutes),
            },
            NOW,
        );

        expect(driven).toBe(false);
    });
});
