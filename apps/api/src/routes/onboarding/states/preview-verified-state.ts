import { LIVE_STEP } from "@autonoma/types";
import { OnboardingState } from "./onboarding-state";

export class PreviewVerifiedState extends OnboardingState {
    readonly step = "preview_verified" as const;

    /**
     * A verified preview IS live: there is nothing between the two that the customer has to
     * decide. `diff_trigger` used to sit here, and its only content was a screen restating what
     * per-PR reviews are plus a button to accept them - so the flow parked on a page that could
     * not act while the work carried on somewhere else.
     */
    override async completePreviewOnboarding(): Promise<void> {
        await this.goLive();
    }

    /**
     * The same transition under the name a caller that already knows the preview is verified asks
     * for. `goLive` used to belong to `diff_trigger` alone, which sits AFTER this step - so a
     * caller resolving against it built a state that could not perform it and threw. This step now
     * owns both names because it owns the only transition left.
     */
    override async goLive(): Promise<void> {
        this.logger.info("Preview verified; going live");
        await this.db.onboardingState.update({
            where: { applicationId: this.applicationId },
            data: {
                step: LIVE_STEP,
                completedAt: new Date(),
                previewVerificationStatus: "ready",
                previewVerificationError: null,
            },
        });
    }
}
