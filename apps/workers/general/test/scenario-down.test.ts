import type { ScenarioInstance } from "@autonoma/db";
import type { ScenarioManager } from "@autonoma/scenario";
import { describe, expect, it, vi } from "vitest";
import { scenarioDown } from "../src/activities/scenario/scenario-down";

function fakeInstance(overrides: Partial<ScenarioInstance> = {}): ScenarioInstance {
    return {
        id: "inst-1",
        applicationId: "app-1",
        scenarioId: "scen-1",
        status: "DOWN_SUCCESS",
        requestedAt: new Date(),
        expiresAt: new Date(),
        upAt: new Date(),
        downAt: new Date(),
        completedAt: new Date(),
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

describe("scenarioDown", () => {
    it("completes successfully when down succeeds", async () => {
        const instance = fakeInstance({ status: "DOWN_SUCCESS" });
        const manager = { down: vi.fn().mockResolvedValue(instance) } as unknown as ScenarioManager;

        await scenarioDown({ scenarioInstanceId: "inst-1" }, { manager });

        expect(manager.down).toHaveBeenCalledWith("inst-1");
    });

    it("completes successfully when no instance exists", async () => {
        const manager = { down: vi.fn().mockResolvedValue(undefined) } as unknown as ScenarioManager;

        await scenarioDown({ scenarioInstanceId: "inst-1" }, { manager });

        expect(manager.down).toHaveBeenCalledWith("inst-1");
    });

    it("throws when instance status is DOWN_FAILED", async () => {
        const instance = fakeInstance({
            status: "DOWN_FAILED",
            lastError: { message: "teardown timeout" },
        });
        const manager = { down: vi.fn().mockResolvedValue(instance) } as unknown as ScenarioManager;

        await expect(scenarioDown({ scenarioInstanceId: "inst-1" }, { manager })).rejects.toThrow(
            "Scenario down failed",
        );
    });
});
