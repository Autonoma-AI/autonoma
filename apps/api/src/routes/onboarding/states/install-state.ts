import { OnboardingState } from "./onboarding-state";

export class InstallState extends OnboardingState {
    readonly step = "install" as const;

    override async startConfigure(): Promise<void> {
        this.logger.info("Starting configure");
        await this.db.onboardingState.update({
            where: { applicationId: this.applicationId },
            data: { step: "configure" },
        });
    }
}
