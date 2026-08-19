import { DEFAULT_REQUEST_TIMEOUT_MSEC } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { describe, expect, it } from "vitest";
import {
    type DeployProgress,
    deployOutcomeAtBudget,
    MAX_WAIT_SECONDS,
    toEnvironmentStatus,
} from "../../../src/previewkit/previewkit-environments.service";

const baseRow = {
    status: "ready",
    phase: "deploying",
    error: null,
    urls: { web: "https://web.preview", api: "https://api.preview" },
    headSha: "abc123",
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: new Date("2024-01-02T00:00:00.000Z"),
};

describe("toEnvironmentStatus", () => {
    it("maps a row to the public status shape", () => {
        expect(toEnvironmentStatus("owner/repo", 5, baseRow)).toEqual({
            repoFullName: "owner/repo",
            prNumber: 5,
            status: "ready",
            phase: "deploying",
            createdAt: new Date("2024-01-01T00:00:00.000Z"),
            updatedAt: new Date("2024-01-02T00:00:00.000Z"),
            lastDeployedSha: "abc123",
            urls: { web: "https://web.preview", api: "https://api.preview" },
            error: undefined,
        });
    });

    it("converts null phase and error to undefined", () => {
        const status = toEnvironmentStatus("o/r", 1, { ...baseRow, phase: null, error: null });
        expect(status.phase).toBeUndefined();
        expect(status.error).toBeUndefined();
    });

    it("surfaces an error message when present", () => {
        expect(toEnvironmentStatus("o/r", 1, { ...baseRow, error: "build failed" }).error).toBe("build failed");
    });

    it("keeps only string url values and tolerates non-object urls", () => {
        expect(toEnvironmentStatus("o/r", 1, { ...baseRow, urls: { web: "https://x", bad: 42 } }).urls).toEqual({
            web: "https://x",
        });
        expect(toEnvironmentStatus("o/r", 1, { ...baseRow, urls: null }).urls).toEqual({});
        expect(toEnvironmentStatus("o/r", 1, { ...baseRow, urls: "nope" }).urls).toEqual({});
        expect(toEnvironmentStatus("o/r", 1, { ...baseRow, urls: ["a", "b"] }).urls).toEqual({});
    });
});

const NOW = new Date("2026-08-04T12:00:00.000Z").getTime();
const MINUTE = 60_000;

function progress(overrides: Partial<DeployProgress> = {}): DeployProgress {
    return {
        envStatus: "ready",
        urls: {},
        apps: [],
        watchedStatus: "ready",
        watchedUpdatedAt: NOW,
        watchedIsApp: false,
        ...overrides,
    };
}

describe("deployOutcomeAtBudget", () => {
    it("calls a long-untouched terminal environment idle, so a caller stops instead of polling forever", () => {
        const eighteenDaysAgo = NOW - 18 * 24 * 60 * MINUTE;
        expect(deployOutcomeAtBudget(progress({ watchedUpdatedAt: eighteenDaysAgo }), NOW)).toBe("idle");
    });

    it("still reports in progress right after a trigger, when nothing has written the row yet", () => {
        // The rebuild is a Kubernetes Job; nothing touches the row until its runner starts,
        // so a terminal-and-unchanged target is the expected state for the first minutes.
        expect(deployOutcomeAtBudget(progress({ watchedUpdatedAt: NOW - 2 * MINUTE }), NOW)).toBe("in_progress");
    });

    it("never calls a non-terminal target idle, however long it has been that way", () => {
        const stuck = progress({ watchedStatus: "building", watchedUpdatedAt: NOW - 3 * 24 * 60 * MINUTE });
        expect(deployOutcomeAtBudget(stuck, NOW)).toBe("in_progress");
    });

    it("reads a watched app instance against the app statuses, not the environment ones", () => {
        const longAgo = NOW - 30 * 24 * 60 * MINUTE;
        // "build_failed" is terminal for an app and meaningless for an environment.
        const app = progress({ watchedIsApp: true, watchedStatus: "build_failed", watchedUpdatedAt: longAgo });
        expect(deployOutcomeAtBudget(app, NOW)).toBe("idle");
        expect(deployOutcomeAtBudget({ ...app, watchedIsApp: false }, NOW)).toBe("in_progress");
    });
});

describe("MAX_WAIT_SECONDS", () => {
    it("leaves an MCP client room to receive the answer before it gives up on the request", () => {
        // A blocking wait sends no progress notifications, so the client's deadline runs
        // uninterrupted from the moment it sends the call. Overshooting it is silently
        // expensive: the client reports a timeout while the server runs to completion and
        // records the call as a success. The budget is only part of what the caller waits
        // for - a final status read and the log tail attached to the answer land on top -
        // so the ceiling has to clear the deadline by more than a rounding error.
        const headroomMs = 5_000;
        expect(MAX_WAIT_SECONDS * 1000 + headroomMs).toBeLessThanOrEqual(DEFAULT_REQUEST_TIMEOUT_MSEC);
    });
});
