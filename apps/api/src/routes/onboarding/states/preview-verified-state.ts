import { OnboardingState } from "./onboarding-state";

export class PreviewVerifiedState extends OnboardingState {
    readonly step = "preview_verified" as const;

    override async completePreviewOnboarding(): Promise<void> {
        this.logger.info("Completing preview onboarding");
        await this.db.onboardingState.update({
            where: { applicationId: this.applicationId },
            data: { step: "completed", completedAt: new Date(), previewVerificationStatus: "ready" },
        });
    }
}
