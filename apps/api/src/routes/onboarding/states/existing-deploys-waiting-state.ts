import { OnboardingState } from "./onboarding-state";

export class ExistingDeploysWaitingState extends OnboardingState {
    readonly step = "existing_deploys_waiting" as const;

    /** Idempotent: already waiting for the first deployment signal. */
    override async confirmExistingDeploysSetup(): Promise<void> {
        this.logger.info("Existing-deploys onboarding already waiting for a deployment signal");
    }
}
