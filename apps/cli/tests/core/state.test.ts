import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { initialState, loadState, saveState, markStep, nextPendingStep } from "../../src/core/state";

describe("state", () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await mkdtemp(join(tmpdir(), "test-state-"));
    });

    afterEach(async () => {
        await rm(tempDir, { recursive: true });
    });

    test("initialState returns all pending", () => {
        const state = initialState();
        expect(state.steps.kb).toBe("pending");
        expect(state.steps.entityAudit).toBe("pending");
        expect(state.steps.scenarioRecipe).toBe("pending");
        expect(state.steps.testGenerator).toBe("pending");
    });

    test("loadState returns initial when no file exists", async () => {
        const state = await loadState(tempDir);
        expect(state.steps.kb).toBe("pending");
    });

    test("saveState and loadState round-trip", async () => {
        const state = initialState();
        state.steps.kb = "done";
        await saveState(tempDir, state);

        const loaded = await loadState(tempDir);
        expect(loaded.steps.kb).toBe("done");
        expect(loaded.steps.entityAudit).toBe("pending");
    });

    test("markStep updates and persists", async () => {
        const state = initialState();
        const updated = await markStep(tempDir, state, "kb", "running");
        expect(updated.steps.kb).toBe("running");

        const loaded = await loadState(tempDir);
        expect(loaded.steps.kb).toBe("running");
    });

    test("nextPendingStep returns first pending step", () => {
        const state = initialState();
        expect(nextPendingStep(state)).toBe("projectMapper");

        state.steps.projectMapper = "done";
        expect(nextPendingStep(state)).toBe("pagesFinder");

        state.steps.pagesFinder = "done";
        expect(nextPendingStep(state)).toBe("kb");

        state.steps.kb = "done";
        expect(nextPendingStep(state)).toBe("entityAudit");

        state.steps.entityAudit = "done";
        state.steps.scenarioRecipe = "done";
        state.steps.recipeBuilder = "done";
        expect(nextPendingStep(state)).toBe("testGenerator");
    });

    test("nextPendingStep returns null when all done", () => {
        const state = initialState();
        state.steps.projectMapper = "done";
        state.steps.pagesFinder = "done";
        state.steps.kb = "done";
        state.steps.entityAudit = "done";
        state.steps.scenarioRecipe = "done";
        state.steps.recipeBuilder = "done";
        state.steps.testGenerator = "done";
        expect(nextPendingStep(state)).toBeUndefined();
    });
});
