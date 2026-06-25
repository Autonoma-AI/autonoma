import type { PrismaClient, ScenarioInstance } from "@autonoma/db";
import type { ScenarioManager } from "@autonoma/scenario";
import { describe, expect, it, vi } from "vitest";
import { scenarioUp } from "../src/activities/scenario/scenario-up";

function fakeInstance(overrides: Partial<ScenarioInstance> = {}): ScenarioInstance {
    return {
        id: "inst-1",
        applicationId: "app-1",
        scenarioId: "scen-1",
        status: "UP_SUCCESS",
        requestedAt: new Date(),
        expiresAt: new Date(),
        upAt: new Date(),
        downAt: null,
        completedAt: null,
        auth: null,
        refs: null,
        refsToken: null,
        metadata: null,
        lastError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        organizationId: "org-1",
        ...overrides,
    };
}

function fakeDb(): PrismaClient {
    return {
        testGeneration: {
            findUniqueOrThrow: vi.fn().mockResolvedValue({ snapshotId: "snap-1", testPlan: { scenarioId: "scen-1" } }),
        },
    } as unknown as PrismaClient;
}

describe("scenarioUp", () => {
    it("calls manager.up with a subject and scenarioId from the plan", async () => {
        const instance = fakeInstance();
        const manager = { up: vi.fn().mockResolvedValue(instance) } as unknown as ScenarioManager;

        await scenarioUp({ type: "generation", entityId: "gen-1" }, { db: fakeDb(), manager });

        expect(manager.up).toHaveBeenCalledWith(expect.anything(), "scen-1", { snapshotId: "snap-1" });
    });

    it("returns the provisioned instance id", async () => {
        const instance = fakeInstance({ id: "inst-42" });
        const manager = { up: vi.fn().mockResolvedValue(instance) } as unknown as ScenarioManager;

        const instanceId = await scenarioUp({ type: "generation", entityId: "gen-1" }, { db: fakeDb(), manager });

        expect(instanceId).toBe("inst-42");
    });

    it("throws the underlying error message when instance status is UP_FAILED", async () => {
        const instance = fakeInstance({
            status: "UP_FAILED",
            lastError: { message: "webhook 500" },
        });
        const manager = { up: vi.fn().mockResolvedValue(instance) } as unknown as ScenarioManager;

        await expect(scenarioUp({ type: "generation", entityId: "gen-1" }, { db: fakeDb(), manager })).rejects.toThrow(
            "webhook 500",
        );
    });
});
