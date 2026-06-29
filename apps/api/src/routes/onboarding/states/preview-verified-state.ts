import { OnboardingState } from "./onboarding-state";

export class PreviewVerifiedState extends OnboardingState {
    readonly step = "preview_verified" as const;

    override async completePreviewOnboarding(): Promise<void> {
        this.logger.info("Preview verified; advancing to diff_trigger");
        await this.db.onboardingState.update({
            where: { applicationId: this.applicationId },
            data: { step: "diff_trigger", previewVerificationStatus: "ready" },
        });
    }
}
