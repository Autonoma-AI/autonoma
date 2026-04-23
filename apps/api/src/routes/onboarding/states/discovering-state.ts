import { InvalidOnboardingStepError, OnboardingState } from "./onboarding-state";

/**
 * Transient state while the discover webhook call is in flight. No user
 * operations are legal here — every default method inherited from the base
 * throws. {@link OnboardingManager.getState} checks `discoveringStartedAt` and
 * auto-recovers to `webhook_configuring` if the call crashed or got wedged.
 */
export class DiscoveringState extends OnboardingState {
    readonly step = "discovering" as const;

    override configureAndDiscoverScenarios(): Promise<void> {
        throw new InvalidOnboardingStepError(this.step, "configure scenarios (discovery already in progress)");
    }
}
