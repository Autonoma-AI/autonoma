import { logger } from "@autonoma/logger";
import { describe, expect, it } from "vitest";
import { materializeScenarioRecipe } from "../src/scenario-recipe";

const testLogger = logger.child({ name: "materialize-scenario-recipe.test" });

const identity = { scenarioId: "scn-1", scenarioName: "fallback-name" };

const validation = { status: "validated" as const, method: "checkScenario" as const, phase: "ok" as const };

describe("materializeScenarioRecipe", () => {
    it("materializes a recipe's declared create graph into the recipe payload", () => {
        const result = materializeScenarioRecipe(
            identity,
            {
                name: "authenticated-admin",
                description: "Logged-in admin with one workspace",
                create: {
                    User: [{ _alias: "admin", email: "admin+{{testRunId}}@example.com", role: "admin" }],
                    Workspace: [{ _alias: "ws", name: "Acme", ownerId: { _ref: "admin" } }],
                },
                validation,
            },
            testLogger,
        );

        expect(result).toEqual({
            scenarioId: "scn-1",
            scenarioName: "authenticated-admin",
            description: "Logged-in admin with one workspace",
            entities: {
                User: [{ _alias: "admin", email: "admin+{{testRunId}}@example.com", role: "admin" }],
                Workspace: [{ _alias: "ws", name: "Acme", ownerId: { _ref: "admin" } }],
            },
        });
    });

    it("falls back to the supplied scenario name when the recipe name is empty", () => {
        const result = materializeScenarioRecipe(
            identity,
            { name: "", description: "", create: { User: [{ _alias: "u" }] }, validation },
            testLogger,
        );

        expect(result?.scenarioName).toBe("fallback-name");
        // An empty description is omitted rather than rendered as a blank line.
        expect(result?.description).toBeUndefined();
    });

    it("returns undefined when the fixture does not match the recipe schema", () => {
        // No `create` / `validation` - not a recipe fixture.
        expect(materializeScenarioRecipe(identity, { User: [{ _alias: "u" }] }, testLogger)).toBeUndefined();
    });

    it("returns undefined when the recipe declares no usable create entities", () => {
        const result = materializeScenarioRecipe(
            identity,
            { name: "empty", description: "", create: { User: [], Logs: "noise" }, validation },
            testLogger,
        );

        expect(result).toBeUndefined();
    });

    it("drops non-object array members from the declared create graph", () => {
        const result = materializeScenarioRecipe(
            identity,
            { name: "mixed", description: "", create: { User: [{ _alias: "u" }, "garbage", 42] }, validation },
            testLogger,
        );

        expect(result?.entities).toEqual({ User: [{ _alias: "u" }] });
    });
});
