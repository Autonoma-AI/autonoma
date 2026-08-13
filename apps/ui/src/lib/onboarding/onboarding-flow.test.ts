import { describe, expect, it } from "vitest";
import { ONBOARDING_PHASES, ONBOARDING_VIEW_STEPS, resolveStep, SETUP_STEPS } from "./onboarding-flow";

describe("onboarding flow", () => {
    it("puts every screen except the finish screen on exactly one phase of the rail", () => {
        const railed = ONBOARDING_PHASES.flatMap((phase) => phase.activeSteps);

        expect(new Set(railed).size).toBe(railed.length);
        expect([...railed, "complete"].sort()).toEqual([...ONBOARDING_VIEW_STEPS].sort());
    });

    it("resumes a retired backend step at the finish screen rather than the start", () => {
        expect(resolveStep("diff_trigger")).toBe("complete");
        expect(resolveStep("completed")).toBe("complete");
    });

    it("collapses the backend steps that share a screen, and starts anything unknown at the top", () => {
        expect(resolveStep("previewkit_deploying")).toBe("deploy-verify");
        expect(resolveStep("preview_verified")).toBe("deploy-verify");
        expect(resolveStep("discovering")).toBe("add-app");
        expect(resolveStep("not_a_step")).toBe("add-app");
        expect(resolveStep(undefined)).toBe("add-app");
    });

    it("keeps the setup steps in the order they have to be done", () => {
        expect(SETUP_STEPS).toEqual(["cli", "sdk", "dry-run"]);
    });
});
