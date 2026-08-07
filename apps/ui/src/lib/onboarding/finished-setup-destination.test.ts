import { describe, expect, test } from "vitest";
import { finishedSetupDestination } from "./finished-setup-destination";

describe("finishedSetupDestination", () => {
    test("keeps the user on the page while any of the three checks is outstanding", () => {
        expect(finishedSetupDestination({ setupComplete: false, step: "diff_trigger" })).toBeUndefined();
    });

    /**
     * The reported failure: a planner run finished every check while the page was
     * open, and the page kept rendering three green rows off the very payload that
     * said setup was done. The agent screen has no Finish button, so there was no
     * way forward at all.
     */
    test("leaves the page once setup is complete", () => {
        expect(finishedSetupDestination({ setupComplete: true, step: "completed" })).toBe("home");
    });

    /**
     * A BYO-preview app finishes setup parked on the go-live step. Home has no
     * go-live affordance, so sending it there is a second dead end.
     */
    test("resumes onboarding when the app has still to go live", () => {
        expect(finishedSetupDestination({ setupComplete: true, step: "diff_trigger" })).toBe("resume-onboarding");
        expect(finishedSetupDestination({ setupComplete: true, step: "existing_deploys_waiting" })).toBe(
            "resume-onboarding",
        );
    });
});
