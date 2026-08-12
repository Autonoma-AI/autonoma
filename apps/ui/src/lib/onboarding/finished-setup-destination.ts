import { hasGoneLive } from "@autonoma/types";

/** Where the finish-setup screen sends the user, or `undefined` to stay put. */
export type FinishedSetupDestination = "home" | "resume-onboarding";

interface FinishedSetupInput {
    /** Server-computed: artifacts landed, the SDK answered, and scenarios provisioned. */
    setupComplete: boolean;
    /** The onboarding step the app is parked on. */
    step: string;
}

/**
 * Decides whether a finish-setup screen still has anything to show.
 *
 * Setup being complete is not the same as onboarding being over: a set-up app has
 * still to go live, and the go-live screen lives in the onboarding flow. Home has
 * no go-live affordance, so routing a finished-but-not-live app there would swap
 * one screen with nothing left to click for another - which is the whole failure
 * this answers.
 */
export function finishedSetupDestination(state: FinishedSetupInput): FinishedSetupDestination | undefined {
    if (!state.setupComplete) return undefined;
    return hasGoneLive(state.step) ? "home" : "resume-onboarding";
}
