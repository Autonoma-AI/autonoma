import { describe, expect, test } from "vitest";
import { firstIncompleteSetupStep, isSetupStepDone, isSetupStepReachable, type SetupProgress } from "./setup-progress";

const NOTHING_DONE: SetupProgress = { artifactsUploaded: false, sdkConfigured: false, dryRunPassed: false };
const ALL_DONE: SetupProgress = { artifactsUploaded: true, sdkConfigured: true, dryRunPassed: true };

describe("firstIncompleteSetupStep", () => {
    test("starts at the upload, which is what the later steps consume", () => {
        expect(firstIncompleteSetupStep(NOTHING_DONE)).toBe("cli");
    });

    test("moves to the SDK once artifacts have landed", () => {
        expect(firstIncompleteSetupStep({ ...NOTHING_DONE, artifactsUploaded: true })).toBe("sdk");
    });

    test("moves to the dry run once the SDK answers", () => {
        expect(firstIncompleteSetupStep({ ...ALL_DONE, dryRunPassed: false })).toBe("dry-run");
    });

    test("is undefined once every step is done", () => {
        expect(firstIncompleteSetupStep(ALL_DONE)).toBeUndefined();
    });

    test("holds at the upload even when later work landed out of order", () => {
        // A coding agent can implement the SDK before the planner has ever run, so
        // the outstanding steps are not necessarily a suffix of the list.
        expect(firstIncompleteSetupStep({ ...NOTHING_DONE, sdkConfigured: true })).toBe("cli");
    });
});

describe("isSetupStepDone", () => {
    test("reads each step off the flag it actually depends on", () => {
        const onlySdk: SetupProgress = { ...NOTHING_DONE, sdkConfigured: true };
        expect(isSetupStepDone("sdk", onlySdk)).toBe(true);
        expect(isSetupStepDone("cli", onlySdk)).toBe(false);
        expect(isSetupStepDone("dry-run", onlySdk)).toBe(false);
    });
});

describe("isSetupStepReachable", () => {
    test("lets the user back into a step they already finished", () => {
        expect(isSetupStepReachable("cli", { ...NOTHING_DONE, artifactsUploaded: true })).toBe(true);
    });

    test("opens the first outstanding step", () => {
        expect(isSetupStepReachable("cli", NOTHING_DONE)).toBe(true);
    });

    test("refuses a step past the first outstanding one", () => {
        // The dry run provisions from the recipe the upload delivers, so reaching it
        // early would run against nothing.
        expect(isSetupStepReachable("dry-run", NOTHING_DONE)).toBe(false);
        expect(isSetupStepReachable("sdk", NOTHING_DONE)).toBe(false);
    });

    test("keeps every step open once setup is finished", () => {
        expect(isSetupStepReachable("cli", ALL_DONE)).toBe(true);
        expect(isSetupStepReachable("sdk", ALL_DONE)).toBe(true);
        expect(isSetupStepReachable("dry-run", ALL_DONE)).toBe(true);
    });
});
