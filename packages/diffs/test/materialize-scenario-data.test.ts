import { logger } from "@autonoma/logger";
import { describe, expect, it } from "vitest";
import { materializeScenarioData } from "../src/scenario-data";

const testLogger = logger.child({ name: "materialize-scenario-data.test" });

describe("materializeScenarioData", () => {
    it("materializes a create graph into the scenario data payload", () => {
        const result = materializeScenarioData(
            "Org with one user",
            { User: [{ _alias: "owner", email: "owner@example.test" }] },
            testLogger,
        );

        expect(result).toEqual({
            scenarioName: "Org with one user",
            entities: { User: [{ _alias: "owner", email: "owner@example.test" }] },
        });
    });

    it("drops non-object array members and empty/non-array entries", () => {
        const result = materializeScenarioData(
            "Mixed",
            {
                User: [{ _alias: "owner" }, "garbage", 42],
                EmptyType: [],
                ScalarType: "not-an-array",
            },
            testLogger,
        );

        expect(result?.entities).toEqual({ User: [{ _alias: "owner" }] });
    });

    it("returns undefined for a null graph (historical instance predating the field)", () => {
        expect(materializeScenarioData("Legacy", null, testLogger)).toBeUndefined();
    });

    it("returns undefined when the graph has no usable entity records", () => {
        expect(materializeScenarioData("Empty", { User: [], Logs: "noise" }, testLogger)).toBeUndefined();
    });

    it("returns undefined when the graph is not an object", () => {
        expect(materializeScenarioData("Weird", ["a", "b"], testLogger)).toBeUndefined();
    });

    it("drops prototype-polluting entity-type keys without corrupting the result", () => {
        const result = materializeScenarioData(
            "Sneaky",
            {
                ["__proto__"]: [{ polluted: true }],
                constructor: [{ polluted: true }],
                User: [{ _alias: "owner" }],
            },
            testLogger,
        );

        expect(result?.entities).toEqual({ User: [{ _alias: "owner" }] });
        // The result is a plain object whose prototype was not reparented to the
        // attacker-supplied array, and a fresh object is unpolluted.
        expect(Object.getPrototypeOf(result?.entities)).toBe(Object.prototype);
        const fresh: Record<string, unknown> = {};
        expect(fresh.polluted).toBeUndefined();
    });
});
