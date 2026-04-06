import { OnboardingState } from "./onboarding-state";

export class UrlState extends OnboardingState {
    readonly step = "url" as const;

    override async setUrl(productionUrl: string): Promise<void> {
        this.logger.info("Setting production URL");
        await this.db.onboardingState.update({
            where: { applicationId: this.applicationId },
            data: { step: "completed", productionUrl, completedAt: new Date() },
        });
    }
}
