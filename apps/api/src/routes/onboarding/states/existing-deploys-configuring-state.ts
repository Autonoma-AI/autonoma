import { OnboardingState } from "./onboarding-state";

export class ExistingDeploysConfiguringState extends OnboardingState {
    readonly step = "existing_deploys_configuring" as const;

    override async confirmExistingDeploysSetup(): Promise<void> {
        this.logger.info("Existing-deploys setup confirmed, waiting for first deployment signal");
        await this.db.onboardingState.update({
            where: { applicationId: this.applicationId },
            data: { step: "existing_deploys_waiting" },
        });
    }
}
