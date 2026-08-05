import { describe, expect, test } from "vitest";
import { isStepAtOrPast, resolveEntryPhase, type PhaseInputs } from "../../src/core/onboarding-phase";

function state(overrides: Partial<PhaseInputs> = {}): PhaseInputs {
    return {
        step: "github",
        sdkConfigured: false,
        dryRunPassed: false,
        artifactsUploaded: false,
        ...overrides,
    };
}

describe("isStepAtOrPast", () => {
    test("orders steps along the onboarding sequence", () => {
        expect(isStepAtOrPast("completed", "preview_verified")).toBe(true);
        expect(isStepAtOrPast("preview_verified", "preview_verified")).toBe(true);
        expect(isStepAtOrPast("previewkit_deploying", "preview_verified")).toBe(false);
        expect(isStepAtOrPast("github", "preview_environment")).toBe(false);
    });

    // A CLI on an older release must not read a step it has never heard of as
    // "further along" and skip the preview work the user actually still needs.
    test("treats an unknown step as before everything", () => {
        expect(isStepAtOrPast("some_future_step", "github")).toBe(false);
        expect(isStepAtOrPast("some_future_step", "completed")).toBe(false);
    });
});

describe("resolveEntryPhase", () => {
    test("starts at the preview phase until the preview is verified", () => {
        expect(resolveEntryPhase(state({ step: "preview_environment" }))).toBe("preview");
        expect(resolveEntryPhase(state({ step: "previewkit_deploying" }))).toBe("preview");
    });

    test("skips to the planner once the preview is verified", () => {
        expect(resolveEntryPhase(state({ step: "preview_verified" }))).toBe("planner");
    });

    // Someone who set their preview up by hand and landed on Finish setup gets exactly
    // what the CLI did before it owned the front door.
    test("skips to the planner for a live app that has run nothing yet", () => {
        expect(resolveEntryPhase(state({ step: "completed" }))).toBe("planner");
    });

    test("stays on the planner while either the SDK or the artifacts are outstanding", () => {
        expect(resolveEntryPhase(state({ step: "completed", artifactsUploaded: true }))).toBe("planner");
        expect(resolveEntryPhase(state({ step: "completed", sdkConfigured: true }))).toBe("planner");
    });

    test("has only the dry run left once the planner's output has landed", () => {
        expect(resolveEntryPhase(state({ step: "completed", artifactsUploaded: true, sdkConfigured: true }))).toBe(
            "dryRun",
        );
    });

    test("is done when nothing is outstanding", () => {
        const finished = state({
            step: "completed",
            artifactsUploaded: true,
            sdkConfigured: true,
            dryRunPassed: true,
        });
        expect(resolveEntryPhase(finished)).toBe("done");
    });
});
